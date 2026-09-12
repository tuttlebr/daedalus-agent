"""Generated source-policy contract. Edit protocol/source-policy.schema.json."""

from typing import Literal, TypedDict

SourcePolicyId = Literal[
    "curated_domains",
    "curated_feeds",
    "perplexity_search",
    "known_url_scrape",
    "nvidia_docs",
    "uploaded_documents",
    "workspace_data",
    "x_mcp",
    "cluster_state",
    "network_state",
    "repository_data",
    "fantasy_data",
]

SOURCE_POLICY_IDS: tuple[SourcePolicyId, ...] = (
    "curated_domains",
    "curated_feeds",
    "perplexity_search",
    "known_url_scrape",
    "nvidia_docs",
    "uploaded_documents",
    "workspace_data",
    "x_mcp",
    "cluster_state",
    "network_state",
    "repository_data",
    "fantasy_data",
)


class SourcePolicy(TypedDict, total=False):
    enabledSources: list[SourcePolicyId]
    disabledSources: list[SourcePolicyId]
    requirePlanApproval: bool
    maxResearchToolCalls: int
    notes: str
