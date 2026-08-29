"""Direct, authenticated execution for gate-owned MCP approval requests."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request
from nat_helpers.internal_auth import require_trusted_user
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("daedalus.mcp_approval_api")


class ExecuteMcpApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    server_name: str = Field(min_length=1, max_length=128)
    tool_name: str = Field(min_length=1, max_length=128)
    canonical_arguments: str = Field(min_length=2, max_length=4_000_000)
    arguments_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


def _execution_response(record: Any) -> tuple[dict[str, Any], int]:
    status = str(getattr(record, "status", "running"))
    response: dict[str, Any] = {
        "executionId": record.execution_id,
        "status": status,
    }
    if status == "oauth_required" and record.pending_oauth is not None:
        response.update(
            {
                "authUrl": record.pending_oauth.auth_url,
                "oauthState": record.pending_oauth.oauth_state,
            }
        )
        return response, 202
    if status == "completed":
        response["result"] = record.result
        return response, 200
    if status == "failed":
        response["error"] = record.error or "MCP operation failed"
        return response, 422
    return response, 202


async def _run_exact_mcp_call(
    *,
    manager: Any,
    request: Request,
    body: ExecuteMcpApprovalRequest,
    record: Any,
    execution_store: Any,
    http_flow_handler: Any,
    request_id: str,
    user_id: str,
) -> None:
    async def authenticate(config: Any, method: Any):
        http_flow_handler.set_execution_context(record.execution_id, execution_store)
        return await http_flow_handler.authenticate(config, method)

    try:
        async with manager.session(
            http_connection=request,
            user_authentication_callback=authenticate,
        ) as session:
            builder_info = manager._per_user_builders.get(session.user_id)
            if builder_info is None:
                raise RuntimeError("Per-user MCP builder is unavailable")
            group = await builder_info.builder.get_function_group(body.server_name)
            functions = await group.get_accessible_functions()
            function_name = f"{body.server_name}__{body.tool_name}"
            function = functions.get(function_name)
            if function is None:
                raise RuntimeError("Approved MCP function is unavailable")
            arguments = json.loads(body.canonical_arguments)
            result = await function.ainvoke(arguments)

            import mcp_patches

            if mcp_patches._mcp_result_is_error(result):
                raise RuntimeError("The MCP server rejected the operation")
            # Remote content can contain the full updated document. Keep the
            # application result compact and deterministic.
            await execution_store.set_completed(
                record.execution_id,
                {
                    "status": "completed",
                    "serverName": body.server_name,
                    "toolName": body.tool_name,
                    "argumentsSha256": body.arguments_sha256,
                },
            )
            logger.info(
                "Direct approved MCP execution succeeded: "
                "request_id=%s user=%s server=%s tool=%s hash=%s",
                request_id,
                user_id,
                body.server_name,
                body.tool_name,
                body.arguments_sha256,
            )
    except Exception as exc:  # noqa: BLE001 - fail one background execution safely
        logger.error(
            "Direct approved MCP execution failed: "
            "request_id=%s user=%s server=%s tool=%s error_class=%s",
            request_id,
            user_id,
            body.server_name,
            body.tool_name,
            type(exc).__name__,
        )
        await execution_store.set_failed(
            record.execution_id, "The approved MCP operation failed"
        )
    finally:
        http_flow_handler.clear_execution_context()


def create_mcp_approval_router(
    *,
    session_managers: Sequence[Any],
    execution_store: Any,
    http_flow_handler: Any,
) -> APIRouter:
    """Build the direct execution router against this worker's live runtime."""

    router = APIRouter(prefix="/v1/mcp-approvals", tags=["mcp-approvals"])

    @router.post("/{request_id}/execute")
    async def execute_mcp_approval(
        request_id: str,
        body: ExecuteMcpApprovalRequest,
        request: Request,
        x_user_id: str | None = Header(default=None),
        x_daedalus_internal_token: str | None = Header(default=None),
        x_daedalus_approval_token: str | None = Header(default=None),
    ):
        user_id = require_trusted_user(x_user_id, x_daedalus_internal_token)
        if not request_id or len(request_id) > 128:
            raise HTTPException(status_code=400, detail="Invalid approval request ID")

        try:
            arguments = json.loads(body.canonical_arguments)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=400, detail="Canonical MCP arguments are invalid"
            ) from exc
        if not isinstance(arguments, dict):
            raise HTTPException(
                status_code=400, detail="Canonical MCP arguments must be an object"
            )
        digest = hashlib.sha256(body.canonical_arguments.encode("utf-8")).hexdigest()
        if digest != body.arguments_sha256:
            raise HTTPException(
                status_code=409, detail="Canonical MCP arguments do not match hash"
            )

        import mcp_patches
        from user_interaction.approval_tokens import (
            make_redis_client,
            validate_approval_token,
        )

        # The HTTP route is not an alternate authorization mechanism. Prove
        # the server-side credential is bound to this exact call before
        # entering the MCP runtime; the normal MCP gate consumes it atomically.
        if mcp_patches._is_unrestricted_mcp_group(
            body.server_name
        ) or mcp_patches._has_local_read_only_evidence(
            body.server_name, body.tool_name
        ):
            raise HTTPException(
                status_code=409,
                detail="Direct execution is limited to approval-gated MCP operations",
            )
        approval_ok, _approval_reason = validate_approval_token(
            make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
            user_id=user_id,
            token=(x_daedalus_approval_token or "").strip(),
            action_type="mcp_mutation",
            server_name=body.server_name,
            tool_name=body.tool_name,
            arguments_sha256=body.arguments_sha256,
            consume=False,
        )
        if not approval_ok:
            raise HTTPException(
                status_code=409,
                detail="Exact MCP approval credential is missing or invalid",
            )

        manager = next(
            (
                candidate
                for candidate in session_managers
                if getattr(candidate, "_is_workflow_per_user", False)
            ),
            None,
        )
        if manager is None:
            raise HTTPException(
                status_code=503, detail="Per-user MCP runtime is unavailable"
            )

        record = await execution_store.create_execution()

        record.task = asyncio.create_task(
            _run_exact_mcp_call(
                manager=manager,
                request=request,
                body=body,
                record=record,
                execution_store=execution_store,
                http_flow_handler=http_flow_handler,
                request_id=request_id,
                user_id=user_id,
            )
        )
        try:
            await asyncio.wait_for(record.first_outcome.wait(), timeout=130)
        except TimeoutError:
            pass
        response, status_code = _execution_response(record)
        from fastapi.responses import JSONResponse

        return JSONResponse(response, status_code=status_code)

    return router
