"""Application-owned retrieval result types."""

from typing import Any

from pydantic import BaseModel, Field


class Document(BaseModel):
    page_content: str | None
    metadata: dict[str, Any] = Field(default_factory=dict)


class RetrieverOutput(BaseModel):
    results: list[Document]


class RetrieverError(Exception):
    pass
