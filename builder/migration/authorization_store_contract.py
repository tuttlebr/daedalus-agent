"""Run with the retained image's actual grant and approval store implementations."""

import argparse
import asyncio
import json
import os
from pathlib import Path

import httpx
import redis
from daedalus_runtime.oauth import GoogleOAuth, decode_grant, token_key
from redis.asyncio import from_url
from user_interaction.approval_tokens import ApprovalRequest, issue_approval_token


async def check(mode, record):
    db = from_url(os.environ["REDIS_URL"])
    sync = redis.from_url(os.environ["REDIS_URL"])
    async with httpx.AsyncClient() as http:
        oauth = GoogleOAuth(db, http)
        key = token_key("gmail", "synthetic-alice")
        if mode == "write":
            await oauth._save_token(
                key,
                {
                    "access_token": "synthetic-baseline-access",
                    "refresh_token": "synthetic-baseline-refresh",
                    "scope": "synthetic.read synthetic.write",
                    "expires_in": 3600,
                },
            )
            request = ApprovalRequest(
                **{
                    field: record[field]
                    for field in ApprovalRequest.__dataclass_fields__
                }
            )
            print(json.dumps({"token": issue_approval_token(sync, request)}))
        else:
            saved = decode_grant(await db.get(key))
            if (
                saved["version"] != 2
                or saved["refresh_token"] != "synthetic-rotated-refresh"
            ):
                raise AssertionError("Rollback could not read the rotated grant")
            if (
                await oauth.access_token(
                    "synthetic-alice",
                    {"server_url": "https://gmailmcp.googleapis.com/mcp"},
                )
                != saved["access_token"]
            ):
                raise AssertionError("Rollback could not use the saved access token")
            if (
                saved["scope"] != "synthetic.read synthetic.write"
                or await db.ttl(key) != -1
            ):
                raise AssertionError("Grant scope or persistence changed")
    sync.close()
    await db.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["write", "read"])
    parser.add_argument("record", type=Path)
    args = parser.parse_args()
    asyncio.run(check(args.mode, json.loads(args.record.read_text())))
