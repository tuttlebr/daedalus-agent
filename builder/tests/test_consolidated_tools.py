"""Tests for consolidated production tool configs."""

from image_generation.visual_media_function import VisualMediaFunctionConfig
from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig
from rss_feed.rss_feed_function import RssFeedFunctionConfig
from smart_milvus.register import DomainRetrieverConfig


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


def test_user_document_tool_config_contains_ingest_and_search_settings():
    config = NvIngestFunctionConfig()

    assert config.default_collection_name == "user_uploads"
    assert config.embedder_name == "milvus_embedder"
    assert config.content_field == "text"
    assert config.vector_field == "vector"
    assert config.top_k == 10
    assert config.use_reranker is True


def test_rss_feed_config_accepts_feed_map_and_operation_filter():
    config = RssFeedFunctionConfig(
        feeds={
            "nvidia_blog": "https://feeds.feedburner.com/nvidiablog",
            "semianalysis": "https://newsletter.semianalysis.com/feed",
        },
        enabled_operations=["search_rss"],
    )

    assert "nvidia_blog" in config.feeds
    assert "semianalysis" in config.feeds
    assert config.enabled_operations == ["search_rss"]
