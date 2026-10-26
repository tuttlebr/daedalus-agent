"""Preserve briefing procedures while replacing the reader with a fictional one.

Reviewed hashes are an export guard: a changed canonical resource needs a new
neutralization review before it can be forwarded to a model evaluation.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import shutil
from pathlib import Path

POLICY_VERSION = "synthetic-evaluation-v2"
MEMORY_PRECEDENCE = (
    "Current explicit requests and the current synthetic policy take precedence "
    "over stale or dated memory."
)
PRODUCTION_CONFIG_SHA256 = (
    "1534df8d9da0f749d4c1db79fe7d475275ad1d86c6b0629e75310fc3531e7d45"
)
REVIEWED_SOURCES = {
    "SKILL.md": "94e6a804d24866ef27f2de3686f687340b6fbcd2ebccb64a1e5fa6eb0a5ce775",
    "references/edition-policy.json": "3909d90766b2bd1eb0094cbe7c6332395a190e39e9f96500a519d92814efbd62",
    "references/research-and-sourcing.md": "69d6fa5d8a5f27986070457e747707973c77fe2200ba48c3bf8287b5b8e6075d",
    "references/edition-format.md": "09b83cbc366797385fc82b000e43df9ffd41d0c22e2ba92af29cc5c90db6c2cb",
    "references/editorial-spec.md": "ef7afce3db1bf9734711c927cda6415fca1cd406086a3c0559d60249a73e52c7",
    "scripts/edition_contract.py": "d7a9da020e2c7127aeef0b1963b76ccc2a302535cfa651971228da80dad88d8c",
    "scripts/render_daybook.py": "0a9fac8e329366f657fcea888899db732d5030e940c5f244a725afc3a1c24b0c",
    "scripts/validate_daybook.py": "ddc42c87fd2a6a728914088d092dfc379675ea3762b8219c639e90029774fdb6",
    "assets/daybook-v4.html": "faf00e60b351df2fe5a8722acbefd058b76377d3dbb59d3cdc762ecb8a930786",
    "references/edition-schema.json": "bd0e29f5e727c1ca1314ca0a88610b2e2b0565ccd77985a1faddc6e30456d077",
}
PROSE = (
    "SKILL.md",
    "references/research-and-sourcing.md",
    "references/edition-format.md",
    "references/editorial-spec.md",
)
NOTICE = (
    "> Synthetic evaluation resource. The reader, personal interests, contacts, "
    "locations, holdings, leagues and supplied evidence are fictional. Follow "
    "the complete procedures below using only the frozen fixture sources. "
    "An unavailable tool or missing fixture observation is a source limitation, "
    "never evidence of an empty real account. Public software/tool identifiers, "
    "canonical desk keys and format examples are interface contracts, not facts "
    "about a real reader.\n\n"
)

# Replace personalized topic selections wholesale rather than treating renamed
# real preferences as de-identified data. Preserve each desk's topic count and
# all mechanical cadence, priority, placement and evidence requirements.
TOPICS = {
    "technology": [
        "Public information systems, digitization, accessible software and archive-record discovery, including the fictional Example Catalog and Civic Ledger platforms",
        "Example Civic Archive and Example Library Cooperative technology choices; distinguish announced features from demonstrated deployment",
        "Public-service data portability, software reliability and meaningful open-source updates affecting the fictional civic institutions",
    ],
    "business": [
        "SYN_A prices, earnings, repurchase authorization versus executed purchases and public-service contracts, compared with same-session fictional sector and broad-market benchmarks",
        "SYN_B, SYN_C and SYN_D civic-data software, library-supply agreements and catalog-service commitments; compare promised availability with documented delivery",
        "Fictional municipal funding, public-service supplier financing, debt concentration and named counterparty exposure",
    ],
    "health": [
        "Fictional regulator approvals, withdrawals, safety notices, supply gaps, pricing, access and formulation-specific availability",
        "Interaction, adverse-effect and guideline evidence relevant to the fictional reader; personalize only from authorized synthetic private context",
        "Studies about adult sleep, sedentary work, long hours and travel; apply only conditions actually supplied in the frozen synthetic evidence",
    ],
    "sports": [
        "Fantasy football: Example Owls in Example League One and Example Falcons in Example League Two; refresh identity, scoring, standings, rosters, byes, waiver rules and deadlines from connected evidence",
        "Dated practice participation, official game status, snap and route counts, target share, touches, coaching changes and waiver-relevant breakouts in the fictional league fixture",
        "Example Meteors, Example Harbor and Example College football and men's basketball by season; source any game-day listening links",
    ],
    "world": [
        "Example jurisdictions' access-to-information agreements and consequences for public institutions",
        "Cross-border cultural-material loans, public archive access and documented shipping constraints",
        "Fictional regional energy decisions affecting civic buildings and public-service operating costs",
    ],
    "us": [
        "The example jurisdiction's public-record access, education budgets, municipal energy policy and public-service labor decisions, with implementation status and effective dates",
    ],
    "science": [
        "Conservation-material and document-storage research, distinguishing controlled tests from demonstrated preservation outcomes",
        "Public educational research with explicit comparison groups and clearly bounded claims",
        "Energy use, humidity and environmental monitoring in fictional public buildings",
    ],
    "opinion": [
        "Named fictional analysts' evidence-led arguments about civic budgets, public access and cultural institutions, including material counterevidence",
    ],
    "arts": [
        "Fictional screen, music and publishing technology, creator economics, licensing and creative labor, distinguished from unsupported promotional claims",
    ],
    "style": [
        "Public-service workplace economics, archive-sector training, commute logistics and accessibility for a fictional civic archivist in Example Region",
    ],
    "travel": [
        "Verified disruption, transport operations, fares, transit logistics, timing and trip weather for confirmed synthetic plans",
        "Example Highlands and Example Range outdoor destinations",
    ],
    "michigan-region": [
        "Example City, Example Borough and Example Region developments with practical local or national-business consequences",
    ],
    "weather": [
        "Observed conditions for the fictional Example City location",
        "The three complete calendar days following the frozen fixture day",
    ],
    "email-calendar": [
        "Recent synthetic Gmail threads requiring action or materially changing the fictional reader's plans",
        "Synthetic Google Calendar events for the frozen local day and next three calendar days",
    ],
    "cluster-infrastructure": [
        "Read-only node, workload and rollout evidence in the fictional Example Fleet's authorized namespaces",
        "Example Fleet accelerator device plugins, monitoring, discovery, driver compatibility and allocation failures",
        "Example Fleet reconciliation, drift and recent authorized repository changes",
        "The synthetic controller's adopted devices, client and WAN observations, pending adoptions and material firmware notices",
        "Example storage health and the synthetic maintenance mirror at /synthetic/workspace/maintenance/",
    ],
    "outdoors-field": [
        "Night-sky visibility, meteor-event notices and credible observatory reports around Example City, Example Borough and Example County",
        "Telescope setup, sky-chart literacy and seasonal stargazing plans with the fictional companion Mara Vale",
        "Verified Example Region forecasts interpreted for cloud cover, visibility, wind and stargazing conditions",
    ],
    "culture-leisure": [
        "Bread fermentation, baking, pantry preservation and public workshop ideas in Example City or Example Borough",
        "Acoustic, jazz and choral releases or performances with explicit listening time commitments",
        "Fictional Meridian Station and The Lantern Archive media, including specific shared-viewing ideas with Mara Vale",
    ],
}


def _required_match(pattern, value):
    match = re.search(pattern, value)
    if match is None:
        raise ValueError("Reviewed personalization structure changed")
    return match


def _personal_replacements(policy, skill_text):
    """Derive old identity values from reviewed source; never publish that map."""
    desks = {desk["key"]: desk for desk in policy["desks"]}
    city, region = (
        part.strip() for part in policy["edition"]["home_location"].split(",", 1)
    )
    borough = _required_match(r", in the (.+?) orbit", policy["reader"]["home"]).group(
        1
    )
    county = _required_match(
        r"and ([^,]+ County)", desks["outdoors-field"]["topics"][0]
    ).group(1)
    companion = _required_match(
        r"with (.+)$", desks["outdoors-field"]["topics"][1]
    ).group(1)
    fantasy = _required_match(
        r"Fantasy football: (.+?) in (.+?) and (.+?) in (.+?);",
        desks["sports"]["topics"][0],
    ).groups()
    favorites = desks["sports"]["topics"][2].split(",", 2)
    college = _required_match(r"\s*(.+?) football", favorites[2]).group(1)
    place = _required_match(r"old (.+?) trip", desks["travel"]["rules"][0]).group(1)
    media = _required_match(
        r"orbit of (.+?) and (.+?), including", desks["culture-leisure"]["topics"][2]
    ).groups()
    outside = _required_match(
        r"outrank (.+?) regional news", desks["michigan-region"]["rules"][0]
    ).group(1)
    mirror = _required_match(
        r" to (/\S+)", desks["cluster-infrastructure"]["topics"][-1]
    ).group(1)
    replacements = [
        (
            policy["reader"]["work"],
            "Municipal archive coordinator at the fictional Example Civic Archive; interested in public information access and cultural preservation",
        ),
        (desks["michigan-region"]["label"], "Local / Region"),
        (college, "Example College"),
        (city, "Example City"),
        (region, "Example Region"),
        (borough, "Example Borough"),
        (county, "Example County"),
        (companion, "Mara Vale"),
        (place, "Example Junction"),
        (mirror, "/synthetic/workspace/maintenance/"),
        (favorites[0].strip(), "Example Meteors"),
        (favorites[1].strip(), "Example Harbor"),
        (media[0], "Meridian Station"),
        (media[1], "The Lantern Archive"),
        (outside + " regional", "outside-region"),
        (outside + " dateline", "outside-region dateline"),
        (policy["edition"]["timezone"], "UTC"),
        ("electronic/rock/classical", "acoustic/jazz/choral"),
        ("Electronic, rock, and classical", "Acoustic, jazz, and choral"),
        ("his working life", "their working life"),
    ]
    author = _required_match(r"(?m)^  author: (.+?) <([^>]+)>$", skill_text)
    replacements.extend(
        (
            (author.group(1), "Rowan Example"),
            (author.group(2), "reader@example.invalid"),
        )
    )
    replacements.extend(
        zip(
            fantasy,
            (
                "Example Owls",
                "Example League One",
                "Example Falcons",
                "Example League Two",
            ),
            strict=True,
        )
    )
    watchlist = policy["reader"]["holdings_watchlist"]
    if len(watchlist) != 4:
        raise ValueError("Reviewed watchlist structure changed")
    replacements.extend(
        zip(watchlist, ("SYN_A", "SYN_B", "SYN_C", "SYN_D"), strict=True)
    )
    return sorted(replacements, key=lambda pair: len(pair[0]), reverse=True)


def _replace(text, replacements):
    for original, replacement in replacements:
        pattern = (
            r"\b"
            + r"\s+".join(re.escape(part) for part in original.split())
            + (r"\b" if original[-1:].isalnum() else "")
        )
        if original.startswith("/"):
            pattern = re.escape(original)
        text = re.sub(pattern, lambda _: replacement, text)
    return text


def _walk(value, replacements):
    if isinstance(value, dict):
        return {key: _walk(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [_walk(item, replacements) for item in value]
    return _replace(value, replacements) if isinstance(value, str) else value


def _synthetic_policy(original, replacements):
    policy = _walk(copy.deepcopy(original), replacements)
    policy["policy_version"] = POLICY_VERSION
    policy["edition"]["home_location"] = "Example City, Example Region"
    policy["edition"]["timezone"] = "UTC"
    policy["reader"]["home"] = (
        "Example City, Example Region, in the Example Borough orbit"
    )
    policy["reader"]["work"] = (
        "Municipal archive coordinator at the fictional Example Civic Archive; interested in public information access and cultural preservation"
    )
    policy["reader"]["holdings_watchlist"] = ["SYN_A", "SYN_B", "SYN_C", "SYN_D"]
    policy["selection_rules"][-1] = MEMORY_PRECEDENCE
    for desk in policy["desks"]:
        if desk["key"] not in TOPICS or len(desk["topics"]) != len(TOPICS[desk["key"]]):
            raise ValueError("Reviewed desk topic structure changed")
        desk["topics"] = TOPICS[desk["key"]]
        if desk["key"] == "business":
            desk["rules"][0] = (
                "Check all three fictional beats: SYN_A, civic-data vendors, and public-service funding. A quiet beat need not produce filler."
            )
        elif desk["key"] == "world":
            desk["rules"][0] = (
                "Frame the change in access, service capacity, cost or fictional watchlist exposure. Attribute government and supplier projections; distinguish enacted measures, observed output and deliveries from announcements."
            )
        elif desk["key"] == "sports":
            desk["rules"][2] = (
                "Refresh records, injuries, availability and alternatives every edition. Any supplied season or period examples are dated fixture leads, not recurring facts."
            )
        elif desk["key"] == "travel":
            desk["rules"][0] = (
                "Require confirmed current travel evidence before personalizing travel coverage. Date prices, quote conditions and schedules; state practical consequences for confirmed plans."
            )
    return policy


def _section(text, heading, following, body):
    before, found, rest = text.partition(heading + "\n\n")
    selected, next_heading, after = rest.partition(following)
    if not found or not next_heading or not selected:
        raise ValueError("Reviewed preference section changed")
    return before + found + body.strip() + "\n\n" + next_heading + after


def _fictional_preferences(text, relative):
    if relative == "SKILL.md":
        text, changes = re.subn(
            r"(?s)Do not let older memory restore .*?Retain no raw private memory",
            MEMORY_PRECEDENCE + " Retain no raw private memory",
            text,
        )
        if changes != 1:
            raise ValueError("Reviewed memory-precedence paragraph changed")
    elif relative == "references/research-and-sourcing.md":
        text = _section(
            text,
            "### Outdoors & Field",
            "### Sports",
            """For stargazing, prefer current observatory reports, official sky-event notices,
or a credible public report for Example County. Separate observed conditions
from forecasts or seasonal expectations. Translate verified weather into useful
sky-viewing windows around Example City and Example Borough. Equipment guidance
must solve a concrete observational problem; do not manufacture equipment news.""",
        )
        text = _section(
            text,
            "### Culture & Leisure",
            "## Claims, deduplication, and citations",
            """Use primary recipes, public workshop notices, artist or venue pages, publishers,
and local sources. The fictional reader prefers bread fermentation, baking,
pantry preservation and ceramics workshops in Example City or Example Borough;
acoustic, jazz and choral listening with the time commitment stated; and fictional
Meridian Station or The Lantern Archive media. Include a shared idea with Mara
Vale only when it is specific and useful.""",
        )
        text = text.replace(
            "For AI, NVIDIA, computing, and trusted recent feeds",
            "For public information systems, civic-archive technology, and trusted recent feeds",
        )
        text, changes = re.subn(
            r"(?s)  Deepen only the\n  changes that affect .*?or the Daedalus project\.",
            "  Deepen only changes that materially affect the independently fictional reader's\n  civic-archive work, public information access, institutional budgets or\n  explicitly supplied synthetic interests.",
            text,
        )
        if changes != 1:
            raise ValueError("Reviewed work-preference paragraph changed")
        text = text.replace(
            "- For official NVIDIA product behavior and stable technical context, fetch the\n  relevant official page through the briefing's available search/fetch tools.",
            "- For official public-service software behavior and stable technical context,\n  fetch the publisher's or standards body's page through available search/fetch tools.",
        )
        text = text.replace(
            "Business has three daily signal checks: NVDA, the semiconductor complex, and\nAI-infrastructure economics.",
            "Business has three daily signal checks: fictional civic supplier SYN_A, comparable\ncivic-data vendors, and public-service funding conditions.",
        )
        text = text.replace(
            "Compare NVDA with a\nsemiconductor and broad-market benchmark",
            "Compare SYN_A with an appropriate fictional sector and broad-market benchmark",
        )
        text = text.replace(
            "Report Synology storage health",
            "Report the fictional storage appliance's health",
        )
        text = text.replace(
            "reuse a remembered stalled-mirror condition",
            "reuse stale operational observations",
        )
        text = text.replace(
            "user-supplied records, injuries and Week 4 alternatives",
            "supplied dated records, injuries and lineup alternatives",
        )
        text = text.replace("A WFAN listen link", "A broadcaster listen link")
    elif relative == "references/editorial-spec.md":
        text = text.replace(
            "what changes for compute supply, cost,\ncompetition, work, health, a lineup or a trip",
            "what changes for public-service capacity, cost,\naccess, work, health, a lineup or a trip",
        )
        text = text.replace(
            "a claimed speedup is not production evidence or proof of cheaper inference",
            "a claimed speedup is not production evidence or proof of lower operating cost",
        )
    elif relative == "references/edition-format.md":
        text = text.replace(
            '"label": "NVIDIA Developer Blog"',
            '"label": "Example Civic Archive Publisher"',
        ).replace(
            "https://developer.nvidia.com/example",
            "https://publisher.example.invalid/technical-report",
        )
    return text


def _prose(text, replacements, relative):
    text = _fictional_preferences(text, relative)
    text = _replace(text, replacements)
    text = re.sub(
        r"(?m)^(  author:).*$",
        r"\1 Synthetic Evaluation Fixture <fixture@example.invalid>",
        text,
    )
    text = text.replace(
        '"policy_version": "2026-10-02"', f'"policy_version": "{POLICY_VERSION}"'
    )
    text = text.replace("2026-10-02T08:11:00-04:00", "2026-10-26T12:00:00Z").replace(
        "Friday, October 2, 2026 · 8:11 a.m. EDT", "Monday, October 26, 2026 · noon UTC"
    )
    # Keep the real frontmatter/discovery contract, then add fixture provenance.
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end < 0:
            raise ValueError("Reviewed skill frontmatter changed")
        return text[: end + 5] + "\n" + NOTICE + text[end + 5 :].lstrip("\n")
    return NOTICE + text


def _production_context(canonical, replacements):
    import yaml

    production_path = canonical.parents[1] / "backend/tool-calling-config.yaml"
    production_bytes = production_path.read_bytes()
    production_hash = hashlib.sha256(production_bytes).hexdigest()
    if production_hash != PRODUCTION_CONFIG_SHA256:
        raise ValueError(
            "Production workflow configuration changed; review evaluation fidelity before model forwarding"
        )
    production = yaml.safe_load(production_bytes)
    excluded_workflow = {
        "_type",
        "llm_name",
        "model_routes",
        "request_model_profiles",
        "skill_model_profiles",
        "context_isolation",
        "tools",
        "daily_summary_tools",
        "daily_summary_final_tools",
        "instructions",
    }
    return {
        "schema_version": 2,
        "workflow_instructions": _replace(
            production["workflow"]["instructions"], replacements
        ),
        "tool_descriptions": {
            name: _replace(settings["description"], replacements)
            for name, settings in production["functions"].items()
            if isinstance(settings, dict)
            and isinstance(settings.get("description"), str)
        },
        "max_history": production["workflow"]["max_history"],
        "max_history_tokens": production["workflow"]["max_history_tokens"],
        "model_max_retries": 3,
        "workflow_defaults": _walk(
            {
                key: value
                for key, value in production["workflow"].items()
                if key not in excluded_workflow
            },
            replacements,
        ),
        "request_model_profiles": production["workflow"]["request_model_profiles"],
        "skill_model_profiles": {
            name: profile
            for name, profile in production["workflow"]["skill_model_profiles"].items()
            if name == "daily-summary"
        },
        "unavailable_mapped_skills": sorted(
            name
            for name in production["workflow"]["skill_model_profiles"]
            if name != "daily-summary"
        ),
        "source_verifier": _walk(
            production["functions"]["source_verifier_tool"], replacements
        ),
        "tool_output_retriever": _walk(
            production["functions"]["tool_output_retriever_tool"], replacements
        ),
        "production_config_sha256": production_hash,
        "scope": "Production mechanics and declared descriptions with fictional reader identity. Only source families implemented by the frozen fixture are available; missing families remain unavailable.",
    }


def build_bundle(canonical: Path, destination: Path) -> dict[str, str]:
    """Write one faithful synthetic bundle and its non-model-facing provenance."""
    inputs = {
        relative: (canonical / relative).read_bytes() for relative in REVIEWED_SOURCES
    }
    actual = {
        relative: hashlib.sha256(data).hexdigest() for relative, data in inputs.items()
    }
    if actual != REVIEWED_SOURCES:
        raise ValueError(
            "Canonical briefing resources changed; review synthetic neutralization before model forwarding"
        )
    original = json.loads(inputs["references/edition-policy.json"])
    replacements = _personal_replacements(original, inputs["SKILL.md"].decode())
    policy = _synthetic_policy(original, replacements)
    context = _production_context(canonical, replacements)
    skill = destination / "daily-summary"
    for relative in REVIEWED_SOURCES:
        target = skill / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if relative == "references/edition-policy.json":
            target.write_text(json.dumps(policy, ensure_ascii=False, indent=2) + "\n")
        elif relative in PROSE:
            target.write_text(_prose(inputs[relative].decode(), replacements, relative))
        else:
            shutil.copyfile(canonical / relative, target)
    # A full copy of each workflow paragraph is retained except reviewed reader
    # substitutions. The provenance lives outside the skill's loadable subtree.
    metadata = {
        "schema_version": 2,
        "neutralization": "reviewed-source-derived-fictional-reader-v2",
        "source_sha256": actual,
        "canonical_bytes_preserved": [
            relative
            for relative in REVIEWED_SOURCES
            if relative not in PROSE and relative != "references/edition-policy.json"
        ],
        "model_facing_sources": list(PROSE) + ["references/edition-policy.json"],
        "policy_version": POLICY_VERSION,
        "production_config_sha256": context["production_config_sha256"],
        "scope": "Complete canonical workflow and source/editorial/format rules; fictional reader, topics and identity values. Canonical protocol/tool/source identifiers are unchanged. Missing fixture evidence remains unavailable.",
    }
    (destination / "fixture-provenance.json").write_text(
        json.dumps(metadata, indent=2) + "\n"
    )
    # This context is consumed by the host adapter, not by skill resource loads.
    (destination / "fixture-environment.json").write_text(
        json.dumps(context, ensure_ascii=False, indent=2) + "\n"
    )
    destination.chmod(0o755)
    for path in destination.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    return {
        str(path.relative_to(destination)): hashlib.sha256(
            path.read_bytes()
        ).hexdigest()
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    }
