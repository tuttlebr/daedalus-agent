#!/usr/bin/env python3
"""Preview or create Brandon's Hindsight models; standard library only."""

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

CATALOG = Path(__file__).with_name("models.json")


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(opener, url, key, method="GET", body=None):
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
        method=method,
    )
    with opener.open(req, timeout=60) as response:
        return json.load(response)


def existing_models(opener, root, key):
    result = []
    offset = 0
    while True:
        page = request(opener, f"{root}/mental-models?limit=100&offset={offset}", key)
        items = page.get("items")
        total = page.get("total")
        if not isinstance(items, list) or not isinstance(total, int):
            raise ValueError("Unexpected mental-model listing; no creation attempted.")
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get("id"), str)
            or not isinstance(item.get("name"), str)
            for item in items
        ):
            raise ValueError("Invalid model metadata; no creation attempted.")
        result.extend(items)
        offset += len(items)
        if offset >= total:
            return result
        if not items:
            raise ValueError("Incomplete model listing; no creation attempted.")


def main():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--kind",
        choices=["knowledge-page", "mental-model"],
        default="knowledge-page",
        help="Default: a page backed by a Mental Model, usable by Daedalus chat.",
    )
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument(
        "--select", help="Comma-separated catalog IDs; default: starter set."
    )
    selection.add_argument(
        "--all", action="store_true", help="Select all eight models."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Create missing entries; default is offline preview.",
    )
    parser.add_argument(
        "--auto-refresh",
        action="store_true",
        help="Refresh after consolidation, at most hourly.",
    )
    parser.add_argument("--bank", default=os.environ.get("HINDSIGHT_BANK_ID"))
    parser.add_argument("--api-url", default=os.environ.get("HINDSIGHT_API_URL"))
    args = parser.parse_args()

    available = {model["id"]: model for model in catalog["models"]}
    selected = (
        list(available)
        if args.all
        else [value.strip() for value in args.select.split(",")]
        if args.select
        else catalog["starter"]
    )
    if not selected or any(value not in available for value in selected):
        parser.error("Valid IDs: " + ", ".join(available))
    selected = list(dict.fromkeys(selected))
    suffix = (
        "knowledge-base/pages" if args.kind == "knowledge-page" else "mental-models"
    )
    payloads = []
    for model_id in selected:
        model = available[model_id]
        body = {key: model[key] for key in ("name", "source_query", "max_tokens")}
        body["tags"] = []
        body["trigger"] = {
            "mode": "full",
            "fact_types": ["world", "experience", "observation"],
            "exclude_mental_models": True,
            "refresh_after_consolidation": args.auto_refresh,
        }
        if args.auto_refresh:
            body["trigger"]["min_refresh_interval_seconds"] = 3600
        if args.kind == "mental-model":
            body["id"] = model_id
        payloads.append((model_id, body))

    if not args.apply:
        bank = quote(args.bank or "YOUR_EXISTING_BANK_ID", safe="")
        print(
            json.dumps(
                {
                    "mode": "offline preview; no requests sent",
                    "method": "POST",
                    "path": f"/v1/default/banks/{bank}/{suffix}",
                    "requests": [body for _, body in payloads],
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return 0

    if not args.bank or not args.bank.strip() or not args.api_url:
        parser.error(
            "--apply needs --bank and --api-url (or HINDSIGHT_BANK_ID and HINDSIGHT_API_URL)."
        )
    url = urlsplit(args.api_url)
    if (
        url.scheme not in {"http", "https"}
        or not url.netloc
        or url.username
        or url.password
        or url.query
        or url.fragment
    ):
        parser.error(
            "API URL must be an HTTP(S) base URL without credentials, query, or fragment."
        )
    base = args.api_url.rstrip("/")
    root = f"{base}/v1/default/banks/{quote(args.bank, safe='')}"
    key = os.environ.get("HINDSIGHT_API_KEY", "")
    opener = build_opener(NoRedirects())
    existing = existing_models(opener, root, key)
    for model_id, body in payloads:
        matches = [
            model
            for model in existing
            if model["id"] == model_id
            or model["name"].casefold() == body["name"].casefold()
        ]
        if matches:
            print(f"SKIP {model_id}: existing ID or name; left unchanged.", flush=True)
            continue
        print(f"CREATE {model_id} ({args.kind})", flush=True)
        result = request(opener, f"{root}/{suffix}", key, "POST", body)
        # The server enqueues generation. Acceptance is not completed synthesis.
        receipt = {
            name: result[name]
            for name in ("page_id", "mental_model_id", "operation_id")
            if name in result
        }
        print(json.dumps({"catalog_id": model_id, "accepted": receipt}), flush=True)
        existing.append(
            {"id": result.get("mental_model_id", model_id), "name": body["name"]}
        )
    print(
        "Creation requests finished. Check operations/content in Hindsight before relying on the models."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except HTTPError as exc:
        print(
            f"HTTP {exc.code}; stopped without retrying. Inspect Hindsight before rerunning; earlier creates may have succeeded.",
            file=sys.stderr,
        )
        sys.exit(1)
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        # Do not echo URLs, response bodies, credentials, or private memory.
        print(
            f"Stopped ({type(exc).__name__}). Check connectivity/API compatibility and Hindsight operations before rerunning.",
            file=sys.stderr,
        )
        sys.exit(1)
