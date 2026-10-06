"""Authenticated exact-call execution of server-issued MCP approvals."""

import asyncio
import hashlib
import json
import os

from daedalus_runtime import approval
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from nat_helpers.identity import authenticated_user_id_from_context
from pydantic import BaseModel, ConfigDict, Field


class ExecuteMcpApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_name: str = Field(min_length=1, max_length=128)
    tool_name: str = Field(min_length=1, max_length=128)
    canonical_arguments: str = Field(min_length=2, max_length=4_000_000)
    arguments_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


def create_mcp_approval_router() -> APIRouter:
    router = APIRouter(tags=["mcp-approvals"])

    @router.post("/v1/mcp-approvals/{request_id}/execute")
    async def execute(
        request_id: str, body: ExecuteMcpApprovalRequest, request: Request
    ):
        from user_interaction.approval_tokens import (
            make_redis_client,
            validate_approval_token,
        )

        user = authenticated_user_id_from_context()
        if not request_id or len(request_id) > 128:
            raise HTTPException(400, "Invalid approval request ID")
        try:
            arguments = json.loads(body.canonical_arguments)
        except ValueError as exc:
            raise HTTPException(400, "Canonical MCP arguments are invalid") from exc
        if not isinstance(arguments, dict):
            raise HTTPException(400, "MCP arguments must be an object")
        if (
            hashlib.sha256(body.canonical_arguments.encode()).hexdigest()
            != body.arguments_sha256
        ):
            raise HTTPException(409, "MCP arguments do not match their approved hash")
        if approval._has_local_read_only_evidence(body.server_name, body.tool_name):
            raise HTTPException(
                409, "Direct execution is limited to approval-gated operations"
            )
        valid, _ = await asyncio.to_thread(
            validate_approval_token,
            make_redis_client(os.getenv("APPROVAL_REDIS_URL")),
            user_id=user,
            token=request.headers.get("x-daedalus-approval-token", ""),
            action_type="mcp_mutation",
            server_name=body.server_name,
            tool_name=body.tool_name,
            arguments_sha256=body.arguments_sha256,
            consume=False,
        )
        if not valid:
            raise HTTPException(
                409, "Exact MCP approval credential is missing or invalid"
            )
        record = request.app.state.executions.start(user, body, arguments)
        try:
            await asyncio.wait_for(record.first_outcome.wait(), timeout=130)
        except TimeoutError:
            pass
        status = (
            200
            if record.status == "completed"
            else 422
            if record.status == "failed"
            else 202
        )
        return JSONResponse(record.payload(initial=True), status_code=status)

    @router.get("/executions/{execution_id}")
    async def get_execution(execution_id: str, request: Request):
        record = request.app.state.executions.records.get(execution_id)
        if record is None or record.user != authenticated_user_id_from_context():
            raise HTTPException(404, "Execution not found")
        return record.payload()

    return router
