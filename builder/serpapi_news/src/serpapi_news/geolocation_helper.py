"""Helper for parsing geolocation_retriever output."""

from __future__ import annotations

import logging
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from typing import TypedDict

logger = logging.getLogger(__name__)


class RetrieverMetadata(TypedDict, total=False):
    gps_latitude: float
    gps_longitude: float
    name: str
    country_code: str
    page_content: str


class RetrieverDocument(TypedDict, total=False):
    page_content: str
    metadata: RetrieverMetadata


class RetrieverPayload(TypedDict, total=False):
    results: list[RetrieverDocument]


def _as_mapping(value: object) -> Mapping[str, object] | None:
    """Best-effort conversion of arbitrary values into mapping form."""
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "__dict__"):
        raw = vars(value)
        if isinstance(raw, dict):
            return raw
    return None


def _extract_results(payload: object) -> Sequence[Mapping[str, object]]:
    """Normalise different retriever outputs into a sequence of mappings."""
    documents: list[Mapping[str, object]] = []

    mapping_candidate = _as_mapping(payload)
    if mapping_candidate is not None:
        raw_results = mapping_candidate.get("results")
        if isinstance(raw_results, Sequence):
            for candidate in raw_results:
                candidate_mapping = _as_mapping(candidate)
                if candidate_mapping is not None:
                    documents.append(candidate_mapping)
        if documents:
            return documents

    results_attr = getattr(payload, "results", None)
    if isinstance(results_attr, Sequence):
        for candidate in results_attr:
            candidate_mapping = _as_mapping(candidate)
            if candidate_mapping is not None:
                documents.append(candidate_mapping)

    return documents


@dataclass
class GeolocationResult:
    """Parsed geolocation result from retriever."""

    name: str
    latitude: float
    longitude: float
    country_code: str | None = None
    metadata: dict[str, object] | None = None

    @property
    def display_name(self) -> str:
        metadata_name = None
        if isinstance(self.metadata, Mapping):
            metadata_name = self.metadata.get("page_content")
        return str(metadata_name or self.name)

    @classmethod
    def from_retriever_output(
        cls, retriever_output: object
    ) -> GeolocationResult | None:
        documents = _extract_results(retriever_output)
        if not documents:
            logger.warning("No results found in geolocation_retriever output")
            return None

        first_result = documents[0]

        metadata_map: Mapping[str, object] | None = None
        raw_metadata = first_result.get("metadata")
        metadata_map = _as_mapping(raw_metadata)

        page_content = first_result.get("page_content")

        if metadata_map is None and hasattr(raw_metadata, "__dict__"):
            raw_dict = vars(raw_metadata)
            if isinstance(raw_dict, dict):
                metadata_map = raw_dict

        if metadata_map is None:
            metadata_map = {}

        latitude_value = metadata_map.get("gps_latitude")
        longitude_value = metadata_map.get("gps_longitude")
        country_code_value = metadata_map.get("country_code")

        name_value = metadata_map.get("name")
        if isinstance(name_value, str) and name_value.strip():
            name = name_value.strip()
        elif isinstance(page_content, str) and page_content.strip():
            name = page_content.strip()
        else:
            name = "Unknown"

        if latitude_value is None or longitude_value is None:
            logger.error(
                "Missing GPS coordinates in geolocation result: %s",
                metadata_map,
            )
            return None

        try:
            latitude = float(latitude_value)
            longitude = float(longitude_value)
        except (TypeError, ValueError) as exc:
            logger.exception(
                "Failed to coerce geolocation coordinates to float: %s",
                exc,
            )
            return None

        metadata_dict: dict[str, object] = (
            dict(metadata_map)
            if isinstance(metadata_map, MutableMapping)
            else dict(metadata_map)
        )
        metadata_dict["page_content"] = page_content

        country_code: str | None
        if isinstance(country_code_value, str) and country_code_value:
            country_code = country_code_value
        else:
            country_code = None

        return cls(
            name=name,
            latitude=latitude,
            longitude=longitude,
            country_code=country_code,
            metadata=metadata_dict,
        )
