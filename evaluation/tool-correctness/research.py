"""Frozen multi-source research workloads and evidence-based acceptance checks."""

import json

SOURCES = {
    "https://sources.test/alpha": "雪🌲K73915618",
    "https://sources.test/bravo": "βQ91432765",
}
MISSING = "https://sources.test/charlie"
WORKLOADS = ("comparison", "steering")
BUDGETS = {
    "max_model_calls": 12,
    "max_tool_calls": 12,
    "full_context_chars": 200000,
    "research_context_chars": 60000,
    "research_context_ratio": 0.5,
    "attempt_seconds": 90,
}
EXPECTED = {
    "findings": [
        {"source": url, "release_label": value} for url, value in SOURCES.items()
    ],
    "unavailable": [MISSING],
}


def article(url):
    return (
        "# Synthetic source report\n\nThe release label is later in the verification section.\n\n"
        + "Ordinary background. " * 1500
        + "\n\nVerification code: "
        + SOURCES[url]
        + "\n\n"
        + "Additional context. " * 1500
    )


def prompt(mode, workload, *, steered=False):
    if workload == "steering" and not steered:
        return f'Read only https://sources.test/alpha using webscrape_tool with output_mode {mode}. Find its release label. Return only a JSON object with exactly two keys: "findings" and "unavailable". Each finding must have exactly two keys: "source" (the source URL) and "release_label" (the label). Use an empty unavailable list. Retrieve omitted source material when needed.'
    prefix = (
        "RESEARCH_UPDATE: Keep the completed alpha source and retrieve its omitted material if needed; do not fetch alpha again. Add bravo and charlie. "
        if steered
        else "Compare these three sources. "
    )
    return (
        prefix
        + f'Read https://sources.test/alpha, https://sources.test/bravo, and https://sources.test/charlie using webscrape_tool with output_mode {mode}. Read each URL at most once. Find each available source\'s release label and preserve its exact Unicode characters. Retrieve omitted source material when needed. Never infer absence from a preview. Do not retry an unavailable source or invent its label. Return only a JSON object with exactly two keys: "findings" (one object per available source, ordered alpha then bravo) and "unavailable" (URLs of unavailable sources). Each finding must have exactly two keys: "source" (the source URL) and "release_label" (the label). Use no other tools.'
    )


def assess(result, mode):
    """Check the entire visible answer and actual, ID-bound source/retrieval results."""
    starts, ends = result["starts"], result["ends"]
    try:
        answer_ok = json.loads(result["answer"]) == EXPECTED
    except (ValueError, TypeError):
        answer_ok = False
    ids = [event["id"] for event in starts]
    receipts = {event["id"]: event for event in ends}
    bindings = len(set(ids)) == len(ids) == len(receipts) == len(ends) and set(
        ids
    ) == set(receipts)
    sources, references, recovered = {}, {}, set()
    safe = True
    for event in starts:
        name = event["name"].removeprefix("Function Start: ")
        args = event["payload"]
        receipt = receipts.get(event["id"], {})
        safe &= receipt.get("name") == "Function Complete: " + name
        content = receipt.get("payload", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        if name == "webscrape_tool":
            url = args.get("url")
            safe &= (
                url in (*SOURCES, MISSING)
                and url not in sources
                and args.get("output_mode", "full") == mode
            )
            sources[url] = content
            if mode == "research" and url in SOURCES:
                try:
                    envelope = json.loads(content)
                    reference = envelope["_daedalus_compacted_tool_output"]["reference"]
                    safe &= SOURCES[url] not in content and url in content
                    references[reference] = url
                except (KeyError, ValueError, TypeError):
                    safe = False
        elif name == "tool_output_retriever_tool":
            url = references.get(args.get("reference"))
            safe &= url is not None
            if url and SOURCES[url] in content:
                recovered.add(url)
        else:
            safe = False
    evidence = set(sources) == {*SOURCES, MISSING}
    evidence &= "error" in sources.get(MISSING, "").lower()
    if mode == "research":
        evidence &= recovered == set(SOURCES)
    else:
        evidence &= all(value in sources.get(url, "") for url, value in SOURCES.items())
    checks = {
        "complete": result["done"]
        and result["terminal"] == "stop"
        and not result["errors"],
        "exact_answer_and_citations": answer_ok,
        "bindings": bindings,
        "authorized_calls_once": safe,
        "source_evidence_and_gap": evidence,
        "tool_budget": len(starts) <= BUDGETS["max_tool_calls"],
        "latency_budget": result["latency_ms"] <= 1000 * BUDGETS["attempt_seconds"],
    }
    return {"passed": all(checks.values()), "checks": checks}
