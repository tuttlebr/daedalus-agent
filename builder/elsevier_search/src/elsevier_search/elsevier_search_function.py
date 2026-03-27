"""Elsevier PharmaPendium and Engineering Village search via the Elsevier API."""

import json
import logging
import os

import httpx
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from pydantic import Field

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE_URL = "https://api.elsevier.com"
MAX_RESULTS = 25  # Default result limit per request

PHARMA_MODULES = {
    "activity": "Drug activity / binding / functional assay data",
    "chemistry": "Chemical structure and property data",
    "drugsindications": "Drug-indication approval data (FDA, EMA)",
    "documents": "Full-text document search across PharmaPendium",
    "efficacy": "Clinical efficacy trial data",
    "faers": "FDA Adverse Event Reporting System data",
    "me": "Metabolizing enzymes and transporter data",
    "pk": "Pharmacokinetic parameter data",
    "safety": "Preclinical and clinical safety/toxicology data",
}

EV_DATABASE_CODES = {
    "c": "Compendex/EI Backfile",
    "i": "Inspec/Inspec Archive",
    "n": "NTIS",
    "pc": "Paperchem",
    "cm": "Chimica",
    "cb": "CBNB",
    "el": "EnCompassLIT",
    "ep": "EnCompassPAT",
    "g": "GEOBASE",
    "f": "GeoRef",
    "p": "Patents Plus",
    "u": "US Patents",
    "e": "EP Patents",
    "w": "WO Patents",
    "k": "Knovel",
}

PHARMA_TAXONOMIES = [
    "ActivityTargetsExtended",
    "ActivityTargets",
    "Concomitants",
    "ConcomitantSubstances",
    "Drugs",
    "Effects",
    "Endpoints",
    "Indications",
    "MEDataTypes",
    "Meyler",
    "MEEnzymeTransporters",
    "Pathogens",
    "PKParameters",
    "Species",
    "Sources",
    "Targets",
    "ToxicityParameters",
]


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
class ElsevierSearchConfig(FunctionBaseConfig, name="elsevier_search"):
    """Configuration for the Elsevier search functions."""

    api_key: str = Field(
        default_factory=lambda: os.environ.get("ELSEVIER_API_KEY", ""),
        description="Elsevier API key. Falls back to the ELSEVIER_API_KEY environment variable.",
    )
    inst_token: str = Field(
        default_factory=lambda: os.environ.get("ELSEVIER_INST_TOKEN", ""),
        description="Elsevier institutional token. Falls back to the ELSEVIER_INST_TOKEN environment variable.",
    )
    timeout: float = Field(
        default=30.0,
        description="HTTP timeout in seconds for API requests.",
    )


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _headers(api_key: str, inst_token: str = "") -> dict[str, str]:  # nosec B107
    h = {
        "X-ELS-APIKey": api_key,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if inst_token:
        h["X-ELS-Insttoken"] = inst_token
    return h


async def _get(
    client: httpx.AsyncClient,
    path: str,
    params: dict | None = None,
    api_key: str = "",
    inst_token: str = "",
) -> dict:
    url = f"{BASE_URL}{path}"
    resp = await client.get(url, params=params, headers=_headers(api_key, inst_token))
    resp.raise_for_status()
    return resp.json()


async def _post(
    client: httpx.AsyncClient,
    path: str,
    body: dict,
    api_key: str = "",
    inst_token: str = "",
) -> dict:
    url = f"{BASE_URL}{path}"
    resp = await client.post(url, json=body, headers=_headers(api_key, inst_token))
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Markdown formatters
# ---------------------------------------------------------------------------


def _format_pharma_search(data: dict, module: str) -> str:
    """Format PharmaPendium search results into compact markdown."""
    lines: list[str] = []
    lines.append(f"## PharmaPendium {module.title()} Search Results\n")

    result_data = data.get("data", data)
    count_total = result_data.get("countTotal", "?")
    count_limited = result_data.get("countLimited", "?")
    lines.append(f"**Total results:** {count_total} (showing {count_limited})\n")

    items = result_data.get("items", [])
    if not items:
        lines.append("No results found.")
        return "\n".join(lines)

    for i, item in enumerate(items[:MAX_RESULTS], 1):
        lines.append(f"### Result {i}")
        doc = item.get("document", {})
        for key, val in item.items():
            if key == "document" or val is None or val == "":
                continue
            label = key.replace("_", " ").title()
            if isinstance(val, list):
                val = ", ".join(str(v) for v in val)
            lines.append(f"- **{label}:** {val}")
        if doc:
            if doc.get("author"):
                lines.append(f"- **Author:** {doc['author']}")
            if doc.get("journal"):
                lines.append(f"- **Journal:** {doc['journal']}")
            if doc.get("year"):
                lines.append(f"- **Year:** {doc['year']}")
            if doc.get("doi"):
                lines.append(f"- **DOI:** {doc['doi']}")
            if doc.get("citation"):
                lines.append(f"- **Citation:** {doc['citation']}")
        lines.append("")

    facets = data.get("facets")
    if facets:
        lines.append("### Facets")
        lines.append(f"```json\n{json.dumps(facets, indent=2)[:2000]}\n```")

    return "\n".join(lines)


def _format_ev_results(data: dict) -> str:
    """Format Engineering Village search results into compact markdown."""
    lines: list[str] = []
    lines.append("## Engineering Village Search Results\n")

    page = data.get("PAGE", {})
    total = page.get("RESULTS-COUNT", "?")
    page_num = page.get("PAGE-NUMBER", 1)
    lines.append(f"**Total results:** {total} | **Page:** {page_num}\n")

    results = page.get("PAGE-RESULTS", {}).get("PAGE-ENTRY", [])
    if isinstance(results, dict):
        results = [results]
    if not results:
        lines.append("No results found.")
        return "\n".join(lines)

    for i, entry in enumerate(results[:MAX_RESULTS], 1):
        ei_doc = entry.get("EI-DOCUMENT", {})
        doc_props = ei_doc.get("DOCUMENTPROPERTIES", {})
        title = doc_props.get("TI", "Untitled")
        abstract = doc_props.get("AB", "")
        authors = doc_props.get("AU", "")
        source = doc_props.get("SO", "")
        year = doc_props.get("YR", "")
        doi = doc_props.get("DO", "")
        doc_type = doc_props.get("DT", "")
        accession = doc_props.get("AN", "")

        lines.append(f"### {i}. {title}")
        if authors:
            lines.append(f"- **Authors:** {authors}")
        if source:
            lines.append(f"- **Source:** {source}")
        if year:
            lines.append(f"- **Year:** {year}")
        if doi:
            lines.append(f"- **DOI:** {doi}")
        if doc_type:
            lines.append(f"- **Type:** {doc_type}")
        if accession:
            lines.append(f"- **Accession:** {accession}")
        if abstract:
            lines.append(f"- **Abstract:** {abstract[:500]}")
        lines.append("")

    return "\n".join(lines)


def _format_list(data: list | dict, title: str) -> str:
    """Format a list/taxonomy response."""
    lines: list[str] = [f"## {title}\n"]
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                lines.append(f"- {item}")
            elif isinstance(item, dict):
                name = item.get("name", item.get("label", str(item)))
                lines.append(f"- {name}")
    elif isinstance(data, dict):
        for key, val in data.items():
            lines.append(f"- **{key}:** {val}")
    else:
        lines.append(str(data))
    return "\n".join(lines)


def _format_lookup(data: dict | list) -> str:
    """Format fuzzy lookup results."""
    lines: list[str] = ["## Taxonomy Lookup Results\n"]
    items = (
        data
        if isinstance(data, list)
        else data.get("items", data.get("children", [data]))
    )
    if isinstance(items, dict):
        items = [items]
    for item in items[:50]:
        if isinstance(item, str):
            lines.append(f"- {item}")
        elif isinstance(item, dict):
            name = item.get("name", item.get("label", item.get("value", "")))
            children = item.get("children", [])
            count = f" ({len(children)} children)" if children else ""
            lines.append(f"- **{name}**{count}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Function registration
# ---------------------------------------------------------------------------


@register_function(config_type=ElsevierSearchConfig)
async def elsevier_search_function(config: ElsevierSearchConfig, builder: Builder):
    api_key = config.api_key or os.environ.get("ELSEVIER_API_KEY", "")
    inst_token = config.inst_token or os.environ.get("ELSEVIER_INST_TOKEN", "")

    # -----------------------------------------------------------------------
    # 1. PharmaPendium Search
    # -----------------------------------------------------------------------
    async def pharma_search(
        module: str,
        drugs: str = "",
        drugs_fuzzy: str = "",
        targets: str = "",
        indications: str = "",
        species: str = "",
        sources: str = "",
        parameters: str = "",
        facets: str = "",
        display_columns: str = "",
        first_row: int = 0,
        count: int = 25,
    ) -> str:
        """Search the Elsevier PharmaPendium database for pharmaceutical data.

        Covers drug activity, chemistry, indications, documents, efficacy, FAERS
        adverse events, metabolizing enzymes, pharmacokinetics, and safety data.

        Args:
            module: PharmaPendium module to search. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
            drugs: Comma-separated drug names (exact, from PharmaPendium taxonomy).
                Example: "Aspirin,Ibuprofen"
            drugs_fuzzy: Comma-separated drug name patterns with wildcards.
                Example: "anesth*,benzo*"
            targets: Comma-separated target names from the targets taxonomy.
                Example: "COX-2,5-HT2A"
            indications: Comma-separated indication terms.
                Example: "Pain,Inflammation"
            species: Comma-separated species names. Example: "Human,Rat"
            sources: Comma-separated source names from the sources taxonomy.
            parameters: Comma-separated parameter names (for activity/pk modules).
            facets: Comma-separated facet fields to include in response.
                Example: "drugs,species,targets"
            display_columns: Comma-separated data fields to return. If empty, all
                fields are returned.
            first_row: Pagination offset (0-based). Default 0.
            count: Number of results to return (max 500). Default 25.
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        body: dict = {
            "limitation": {
                "count": min(count, 500),
                "firstRow": max(first_row, 0),
            },
        }
        if drugs:
            body["drugs"] = [d.strip() for d in drugs.split(",")]
        if drugs_fuzzy:
            body["drugsFuzzy"] = [d.strip() for d in drugs_fuzzy.split(",")]
        if targets:
            body["targets"] = [t.strip() for t in targets.split(",")]
        if indications:
            body["indications"] = [i.strip() for i in indications.split(",")]
        if species:
            body["species"] = [s.strip() for s in species.split(",")]
        if sources:
            body["sources"] = [s.strip() for s in sources.split(",")]
        if parameters:
            body["parameters"] = [p.strip() for p in parameters.split(",")]
        if facets:
            body["facets"] = [f.strip() for f in facets.split(",")]
        if display_columns:
            body["displayColumns"] = [c.strip() for c in display_columns.split(",")]

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _post(
                    client, f"/pharma/{mod}/search", body, api_key, inst_token
                )
        except httpx.HTTPStatusError as exc:
            logger.error(
                "PharmaPendium %s search returned %d: %s",
                mod,
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"**Error:** PharmaPendium {mod} search returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("PharmaPendium %s search request failed: %s", mod, exc)
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_pharma_search(data, mod)

    # -----------------------------------------------------------------------
    # 2. PharmaPendium Taxonomy Lookup (Fuzzy)
    # -----------------------------------------------------------------------
    async def pharma_lookup(
        module: str,
        taxonomy: str,
        query: str,
    ) -> str:
        """Fuzzy lookup in a PharmaPendium taxonomy. Supports wildcards (e.g., "aspi*").

        Use this to find valid taxonomy terms before searching. This is essential
        because search filters require exact taxonomy terms.

        Args:
            module: PharmaPendium module. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
            taxonomy: Taxonomy to query. Common values: "Drugs", "Targets", "Species",
                "Indications", "Effects", "Endpoints", "Sources", "PKParameters",
                "MEEnzymeTransporters", "ToxicityParameters", "ActivityTargets",
                "ActivityTargetsExtended", "Concomitants", "ConcomitantSubstances",
                "MEDataTypes", "Meyler", "Pathogens".
            query: Search term with optional wildcards. Example: "Aspir*", "benzo*".
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/lookupFuzzy",
                    params={"taxonomy": taxonomy, "query": query},
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            logger.error(
                "PharmaPendium lookup returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"**Error:** PharmaPendium lookup returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("PharmaPendium lookup failed: %s", exc)
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_lookup(data)

    # -----------------------------------------------------------------------
    # 3. PharmaPendium Suggest (autocomplete)
    # -----------------------------------------------------------------------
    async def pharma_suggest(
        module: str,
        taxonomy: str,
        prefix: str,
    ) -> str:
        """Autocomplete/suggest taxonomy terms in PharmaPendium by prefix.

        Returns matching taxonomy terms that have associated data in the module.
        Use this to discover valid drug names, targets, species, etc.

        Args:
            module: PharmaPendium module. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
            taxonomy: Taxonomy to query (e.g., "Drugs", "Targets", "Species").
            prefix: Prefix to autocomplete. Example: "asp" returns "Aspirin", etc.
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/suggest",
                    params={"taxonomy": taxonomy, "prefix": prefix},
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            logger.error(
                "PharmaPendium suggest returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"**Error:** PharmaPendium suggest returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("PharmaPendium suggest failed: %s", exc)
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_list(data, f"Suggest: '{prefix}' in {taxonomy} ({mod})")

    # -----------------------------------------------------------------------
    # 4. PharmaPendium List Data Fields
    # -----------------------------------------------------------------------
    async def pharma_list_fields(
        module: str,
    ) -> str:
        """List available data fields for a PharmaPendium module.

        Use this to discover which display columns are available for search results.

        Args:
            module: PharmaPendium module. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/listDataFields",
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            return f"**Error:** Returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_list(data, f"Data Fields for {mod}")

    # -----------------------------------------------------------------------
    # 5. PharmaPendium List Taxonomies
    # -----------------------------------------------------------------------
    async def pharma_list_taxonomies(
        module: str,
    ) -> str:
        """List available taxonomies for a PharmaPendium module.

        Taxonomies define the controlled vocabularies used for filtering searches.
        Use this to discover which taxonomy names to use with pharma_lookup and pharma_suggest.

        Args:
            module: PharmaPendium module. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/listTaxonomies",
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            return f"**Error:** Returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_list(data, f"Taxonomies for {mod}")

    # -----------------------------------------------------------------------
    # 6. PharmaPendium List Facets
    # -----------------------------------------------------------------------
    async def pharma_list_facets(
        module: str,
    ) -> str:
        """List available facets for a PharmaPendium module.

        Facets can be requested in search to get aggregated counts by category.

        Args:
            module: PharmaPendium module. One of: "activity", "chemistry",
                "drugsindications", "documents", "efficacy", "faers", "me", "pk", "safety".
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in PHARMA_MODULES:
            return f"**Error:** Invalid module '{module}'. Valid modules: {', '.join(PHARMA_MODULES.keys())}"

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/listFacets",
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            return f"**Error:** Returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_list(data, f"Facets for {mod}")

    # -----------------------------------------------------------------------
    # 7. PharmaPendium Get Units (Activity and PK only)
    # -----------------------------------------------------------------------
    async def pharma_get_units(
        module: str,
        parameter: str,
    ) -> str:
        """Get filterable units for a parameter in the Activity or PK module.

        Only available for the "activity" and "pk" modules.

        Args:
            module: Either "activity" or "pk".
            parameter: The parameter name to get units for.
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        mod = module.lower().strip()
        if mod not in ("activity", "pk"):
            return (
                "**Error:** getUnits is only available for 'activity' and 'pk' modules."
            )

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/{mod}/getUnits",
                    params={"parameter": parameter},
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            return f"**Error:** Returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            return f"**Error:** Could not reach Elsevier API: {exc}"

        return _format_list(data, f"Units for '{parameter}' ({mod})")

    # -----------------------------------------------------------------------
    # 8. FAERS Get Report
    # -----------------------------------------------------------------------
    async def pharma_faers_report(
        image: str,
    ) -> str:
        """Get a specific FAERS adverse event report by its image/accession code.

        Args:
            image: The FAERS report image/accession identifier.
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    f"/pharma/faers/get/{image}",
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            return f"**Error:** Returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            return f"**Error:** Could not reach Elsevier API: {exc}"

        lines: list[str] = [f"## FAERS Report: {image}\n"]
        if isinstance(data, dict):
            for key, val in data.items():
                if val is not None and val != "":
                    label = key.replace("_", " ").title()
                    if isinstance(val, (list, dict)):
                        lines.append(
                            f"**{label}:**\n```json\n{json.dumps(val, indent=2)[:2000]}\n```"
                        )
                    else:
                        lines.append(f"- **{label}:** {val}")
        else:
            lines.append(str(data)[:3000])
        return "\n".join(lines)

    # -----------------------------------------------------------------------
    # 9. Engineering Village Search
    # -----------------------------------------------------------------------
    async def engineering_village_search(
        query: str,
        database: str = "",
        start_year: int = 0,
        end_year: int = 0,
        sort_field: str = "relevance",
        sort_direction: str = "dw",
        offset: int = 0,
        page_size: int = 25,
        auto_stemming: bool = False,
        navigator: bool = False,
    ) -> str:
        """Search the Engineering Village databases using expert search syntax.

        Searches across engineering, scientific, and patent literature databases
        including Compendex, Inspec, NTIS, GeoRef, GEOBASE, Patents, and more.

        Expert search supports Boolean operators (AND, OR, NOT), proximity/near
        operators, field codes (e.g., wn=title, au=author), wildcards (*,?),
        and exact phrases in braces {}.

        Args:
            query: Expert search query string. Examples:
                - "machine learning AND drug discovery"
                - "{neural network} AND wn KY"  (in keyword field)
                - "CRISPR NEAR/3 therapy"  (proximity search)
                - "au=Smith AND py=2023"  (author + year)
            database: Comma-separated database codes to search. If empty, searches
                all entitled databases. Codes: c=Compendex, i=Inspec, n=NTIS,
                pc=Paperchem, cm=Chimica, cb=CBNB, el=EnCompassLIT, ep=EnCompassPAT,
                g=GEOBASE, f=GeoRef, p=Patents Plus, u=US Patents, e=EP Patents,
                w=WO Patents, k=Knovel.
            start_year: Filter results from this year onward. 0 for no filter.
            end_year: Filter results up to this year. 0 for no filter.
            sort_field: Sort field. One of: "relevance" (default), "yr" (year),
                "ausort" (author), "stsort" (source), "pnsort" (publisher).
            sort_direction: Sort direction. "dw" (descending, default) or "up" (ascending).
            offset: Pagination offset (0-based). Default 0.
            page_size: Results per page (default 25).
            auto_stemming: Enable automatic stemming of search terms.
            navigator: Include navigator/facet data in response.
        """
        if not api_key:
            return "**Error:** No Elsevier API key configured. Set the ELSEVIER_API_KEY environment variable."

        params: dict[str, str | int | bool] = {
            "apiKey": api_key,
            "query": query,
            "sortField": sort_field,
            "sortDirection": sort_direction,
            "offset": offset,
            "pageSize": min(page_size, 100),
        }
        if database:
            params["database"] = database
        if start_year > 0:
            params["startYear"] = start_year
        if end_year > 0:
            params["endYear"] = end_year
        if auto_stemming:
            params["autoStemming"] = True
        if navigator:
            params["navigator"] = True

        try:
            async with httpx.AsyncClient(timeout=config.timeout) as client:
                data = await _get(
                    client,
                    "/content/ev/results",
                    params=params,
                    api_key=api_key,
                    inst_token=inst_token,
                )
        except httpx.HTTPStatusError as exc:
            logger.error(
                "EV search returned %d: %s",
                exc.response.status_code,
                exc.response.text[:500],
            )
            return f"**Error:** Engineering Village returned status {exc.response.status_code}."
        except httpx.RequestError as exc:
            logger.error("EV search failed: %s", exc)
            return f"**Error:** Could not reach Engineering Village API: {exc}"

        return _format_ev_results(data)

    # -----------------------------------------------------------------------
    # Yield all functions to the agent
    # -----------------------------------------------------------------------
    try:
        yield FunctionInfo.from_fn(
            pharma_search,
            description=(
                "Search the Elsevier PharmaPendium database for pharmaceutical and biomedical data. "
                "Covers 9 modules: activity (binding/functional assays), chemistry (structures/properties), "
                "drugsindications (FDA/EMA approvals), documents (full-text), efficacy (clinical trials), "
                "faers (FDA adverse events), me (metabolizing enzymes), pk (pharmacokinetics), "
                "safety (toxicology). Filter by drugs, targets, species, indications, and more. "
                "Use pharma_lookup or pharma_suggest first to find valid taxonomy terms for filters."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_lookup,
            description=(
                "Fuzzy lookup of terms in PharmaPendium taxonomies. Supports wildcards (e.g., 'aspi*'). "
                "Use this to find valid drug names, targets, species, etc. before searching. "
                "Essential because pharma_search filters require exact taxonomy terms."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_suggest,
            description=(
                "Autocomplete/suggest PharmaPendium taxonomy terms by prefix. "
                "Returns terms that have associated data in the specified module. "
                "Use to discover valid drug names, targets, species, indications, etc."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_list_fields,
            description=(
                "List available data fields for a PharmaPendium module. "
                "Use to discover which display_columns can be specified in pharma_search."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_list_taxonomies,
            description=(
                "List available taxonomies for a PharmaPendium module. "
                "Taxonomies are controlled vocabularies used in pharma_lookup and pharma_suggest."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_list_facets,
            description=(
                "List available facets for a PharmaPendium module. "
                "Facets can be requested in pharma_search to get aggregated counts."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_get_units,
            description=(
                "Get filterable units for a parameter in the Activity or PK module. "
                "Only available for 'activity' and 'pk' modules."
            ),
        )
        yield FunctionInfo.from_fn(
            pharma_faers_report,
            description=(
                "Get a specific FAERS (FDA Adverse Event Reporting System) report by its "
                "image/accession identifier. Returns detailed adverse event information."
            ),
        )
        yield FunctionInfo.from_fn(
            engineering_village_search,
            description=(
                "Search Engineering Village databases for engineering, scientific, and patent literature. "
                "Uses expert search syntax with Boolean operators (AND, OR, NOT), proximity operators "
                "(NEAR/n), field codes (wn=title, au=author), and wildcards. "
                "Databases include Compendex, Inspec, NTIS, GEOBASE, GeoRef, Knovel, "
                "and multiple patent databases (US, EP, WO). "
                "Ideal for finding technical papers, patents, and engineering standards."
            ),
        )
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up elsevier_search function.")
