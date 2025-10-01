"""Helper for parsing geolocation_retriever output."""

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class GeolocationResult:
    """Parsed geolocation result from retriever."""

    name: str
    latitude: float
    longitude: float
    country_code: str | None = None
    metadata: dict[str, Any] | None = None

    @property
    def display_name(self) -> str:
        """Get a human-readable display name."""
        if self.metadata and "page_content" in self.metadata:
            return self.metadata["page_content"]
        return self.name

    @classmethod
    def from_retriever_output(
        cls, retriever_output: dict[str, Any]
    ) -> "GeolocationResult | None":
        """
        Parse geolocation_retriever output format.

        Expected format:
        {
            "results": [{
                "page_content": "Saline,Michigan,United States",
                "metadata": {
                    "gps_latitude": 42.1667072,
                    "gps_longitude": -83.7816075,
                    "name": "Saline",
                    "country_code": "US",
                    ...
                },
                "document_id": "..."
            }]
        }

        Args:
            retriever_output: The output from geolocation_retriever

        Returns:
            GeolocationResult if successful, None otherwise
        """
        try:
            results = retriever_output.get("results", [])
            if not results:
                logger.warning("No results found in geolocation_retriever output")
                return None

            # Take the first (best) result
            first_result = results[0]
            metadata = first_result.get("metadata", {})

            # Extract required fields
            latitude = metadata.get("gps_latitude")
            longitude = metadata.get("gps_longitude")
            name = metadata.get("name") or first_result.get("page_content", "Unknown")
            country_code = metadata.get("country_code")

            if latitude is None or longitude is None:
                logger.error(
                    "Missing GPS coordinates in geolocation result: %s", metadata
                )
                return None

            # Store full metadata including page_content for display
            full_metadata = {
                **metadata,
                "page_content": first_result.get("page_content"),
            }

            return cls(
                name=name,
                latitude=float(latitude),
                longitude=float(longitude),
                country_code=country_code,
                metadata=full_metadata,
            )

        except Exception as exc:
            logger.exception("Failed to parse geolocation_retriever output: %s", exc)
            return None
