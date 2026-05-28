"""Tests for consolidated production tool configs."""

from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig
from rss_feed.rss_feed_function import RssFeedFunctionConfig
from smart_milvus.register import DomainRetrieverConfig
from visual_media.visual_media_function import (
    VisualMediaFunctionConfig,
    _chat_completions_url,
    _validated_user_id,
)


def test_visual_media_config_groups_image_and_vlm_settings():
    config = VisualMediaFunctionConfig(
        image_api_endpoint="https://images.example.com/v1",
        generation_model="gpt-image-2",
        edit_model="gpt-image-1.5",
        comprehension_api_endpoint="https://vlm.example.com/v1",
        comprehension_model="nvidia/custom-vlm",
    )

    assert config.image_api_endpoint == "https://images.example.com/v1"
    assert config.generation_model == "gpt-image-2"
    assert config.edit_model == "gpt-image-1.5"
    assert config.comprehension_api_endpoint == "https://vlm.example.com/v1"
    assert config.comprehension_model == "nvidia/custom-vlm"


def test_visual_media_chat_completions_url_accepts_v1_base():
    assert (
        _chat_completions_url("https://vlm.example.com/v1")
        == "https://vlm.example.com/v1/chat/completions"
    )


def test_visual_media_chat_completions_url_accepts_full_path():
    assert (
        _chat_completions_url("https://vlm.example.com/v1/chat/completions")
        == "https://vlm.example.com/v1/chat/completions"
    )


def test_visual_media_requires_user_id_for_user_scoped_refs():
    user_id, error = _validated_user_id(
        {"imageId": "abc", "sessionId": "sess", "userId": "alice"},
        "",
    )

    assert user_id is None
    assert "user_id is required" in error


def test_visual_media_accepts_authenticated_user_id_for_user_scoped_refs():
    user_id, error = _validated_user_id(
        {"imageId": "abc", "sessionId": "sess", "userId": "alice"},
        "alice",
    )

    assert user_id == "alice"
    assert error is None


def test_domain_retriever_config_defaults_to_curated_domains():
    config = DomainRetrieverConfig(
        uri="http://milvus:19530",
        embedding_model="milvus_embedder",
    )

    assert config.domain_collections["nvidia"] == "nvidia"
    assert config.domain_collections["semianalysis"] == "semianalysis"
    assert config.domain_collections["kubernetes"] == "kubernetes"
    assert config.domain_collections["veterinarian"] == "vetpartner"
    assert config.domain_collections["mentalhealth"] == "mentalhealth"


def test_domain_retriever_config_defaults_milvus_auth_from_env(monkeypatch):
    monkeypatch.setenv("MILVUS_USERNAME", "root")
    monkeypatch.setenv("MILVUS_PASSWORD", "Milvus")
    monkeypatch.delenv("MILVUS_TOKEN", raising=False)

    config = DomainRetrieverConfig(
        uri="http://milvus:19530",
        embedding_model="milvus_embedder",
    )

    assert config.connection_args == {"user": "root", "password": "Milvus"}


def test_user_document_tool_config_contains_ingest_and_search_settings():
    config = NvIngestFunctionConfig()

    assert config.default_collection_name == "user_uploads"
    assert config.embedder_name == "milvus_embedder"
    assert config.content_field == "text"
    assert config.vector_field == "vector"
    assert config.top_k == 10
    assert config.use_reranker is True


def test_rss_feed_config_accepts_feed_map():
    config = RssFeedFunctionConfig(
        feeds={
            "nvidia_blog": "https://feeds.feedburner.com/nvidiablog",
            "semianalysis": "https://newsletter.semianalysis.com/feed",
        },
    )

    assert "nvidia_blog" in config.feeds
    assert "semianalysis" in config.feeds
