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
    def from_retriever_output(cls, retriever_output: Any) -> "GeolocationResult | None":
        """
        Parse geolocation_retriever output format.

        Expected format (NAT RetrieverOutput object or dict):
        RetrieverOutput(results=[Document(...)])
        OR
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
            # Handle RetrieverOutput object (has .results attribute)
            if hasattr(retriever_output, "results"):
                results = retriever_output.results
            # Handle dict format
            elif isinstance(retriever_output, dict):
                results = retriever_output.get("results", [])
            else:
                logger.error(
                    "Unknown retriever output type: %s", type(retriever_output)
                )
                return None

            if not results:
                logger.warning("No results found in geolocation_retriever output")
                return None

            # Take the first (best) result - handle both Document object and dict
            first_result = results[0]

            # Extract metadata - handle both object and dict
            if hasattr(first_result, "metadata"):
                metadata = first_result.metadata
                page_content = getattr(first_result, "page_content", None)
            elif isinstance(first_result, dict):
                metadata = first_result.get("metadata", {})
                page_content = first_result.get("page_content")
            else:
                logger.error("Unknown result type: %s", type(first_result))
                return None

            # Extract required fields - handle both dict and object
            if isinstance(metadata, dict):
                latitude = metadata.get("gps_latitude")
                longitude = metadata.get("gps_longitude")
                name = metadata.get("name") or page_content or "Unknown"
                country_code = metadata.get("country_code")
            else:
                # metadata is an object, use getattr
                latitude = getattr(metadata, "gps_latitude", None)
                longitude = getattr(metadata, "gps_longitude", None)
                name = getattr(metadata, "name", None) or page_content or "Unknown"
                country_code = getattr(metadata, "country_code", None)

            if latitude is None or longitude is None:
                logger.error(
                    "Missing GPS coordinates in geolocation result: %s", metadata
                )
                return None

            # Store full metadata including page_content for display
            if isinstance(metadata, dict):
                full_metadata = {
                    **metadata,
                    "page_content": page_content,
                }
            else:
                # Convert object to dict
                metadata_dict = vars(metadata) if hasattr(metadata, "__dict__") else {}
                full_metadata = {
                    **metadata_dict,
                    "page_content": page_content,
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
