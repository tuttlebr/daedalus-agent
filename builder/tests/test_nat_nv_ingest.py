"""Unit tests for nat_nv_ingest configuration and pure helpers."""

from nat_nv_ingest.nat_nv_ingest import (
    IngestResult,
    NvIngestFunctionConfig,
    _dedup_entries,
    _normalize_for_dedup,
    _text_quality_score,
    clean_markdown,
    clean_table_markdown,
    format_batch_response,
    format_single_doc_response,
    normalize_collection_part,
    resolve_user_collection_name,
    results_to_markdown,
    user_upload_collection_name,
)

# ---------------------------------------------------------------------------
# NvIngestFunctionConfig
# ---------------------------------------------------------------------------


class TestNvIngestFunctionConfig:
    def test_defaults(self):
        config = NvIngestFunctionConfig()
        assert config.nv_ingest_host == "localhost"
        assert config.nv_ingest_port == 7670
        assert config.milvus_uri == "http://localhost:19530"
        assert config.minio_endpoint == "localhost:9000"
        assert config.minio_access_key == "minioadmin"
        assert config.minio_secret_key == "minioadmin"
        assert config.chunk_size == 1024
        assert config.chunk_overlap == 150
        assert config.embedder_dim == 2048
        assert config.recreate_collection is False
        assert config.default_collection_name == "user_uploads"

    def test_redis_url_default(self):
        config = NvIngestFunctionConfig()
        assert "localhost" in config.redis_url

    def test_custom_host_port(self):
        config = NvIngestFunctionConfig(
            nv_ingest_host="nv-ingest-service",
            nv_ingest_port=7671,
        )
        assert config.nv_ingest_host == "nv-ingest-service"
        assert config.nv_ingest_port == 7671

    def test_custom_chunk_settings(self):
        config = NvIngestFunctionConfig(chunk_size=512, chunk_overlap=64)
        assert config.chunk_size == 512
        assert config.chunk_overlap == 64

    def test_custom_milvus_uri(self):
        config = NvIngestFunctionConfig(milvus_uri="http://milvus:19530")
        assert config.milvus_uri == "http://milvus:19530"

    def test_recreate_collection_flag(self):
        config = NvIngestFunctionConfig(recreate_collection=True)
        assert config.recreate_collection is True

    def test_custom_collection_name(self):
        config = NvIngestFunctionConfig(default_collection_name="my_docs")
        assert config.default_collection_name == "my_docs"

    def test_custom_embedder_dim(self):
        config = NvIngestFunctionConfig(embedder_dim=1024)
        assert config.embedder_dim == 1024

    def test_minio_credentials(self):
        config = NvIngestFunctionConfig(
            minio_access_key="access123",
            minio_secret_key="secret456",
        )
        assert config.minio_access_key == "access123"
        assert config.minio_secret_key == "secret456"

    def test_pipeline_field_defaults(self):
        """New config fields added during the improvement pass."""
        config = NvIngestFunctionConfig()
        assert config.tokenizer == "meta-llama/Llama-3.2-1B"
        assert config.minio_bucket == "nv-ingest"
        assert config.extract_method == "pdfium"
        assert config.max_documents_per_batch == 20
        assert config.batch_concurrency == 4
        assert config.worker_pool_size == 16
        assert config.use_v2_api is False
        assert config.pdf_pages_per_chunk == 32
        assert config.enable_image_filter is True
        assert config.enable_captioning is False
        assert config.caption_model_name is None
        assert config.caption_endpoint_url is None
        assert config.caption_api_key is None
        assert config.redis_socket_timeout == 30
        assert config.redis_connect_timeout == 5
        assert config.ingest_max_retries == 2
        assert config.ingest_retry_delay == 1.0


class TestCollectionResolution:
    def test_normalizes_collection_parts(self):
        assert normalize_collection_part("Brandon Smith@example.com") == (
            "brandon_smith_example_com"
        )
        assert normalize_collection_part("123") == "u_123"

    def test_user_upload_collection_name_uses_base_and_user(self):
        assert user_upload_collection_name("Brandon Smith") == (
            "user_uploads_brandon_smith"
        )

    def test_resolve_uses_explicit_collection_when_present(self):
        assert resolve_user_collection_name("My Docs", "brandon") == "my_docs"

    def test_resolve_derives_per_user_default(self):
        assert resolve_user_collection_name(None, "brandon") == "user_uploads_brandon"


# ---------------------------------------------------------------------------
# clean_markdown
# ---------------------------------------------------------------------------


class TestCleanMarkdown:
    def test_empty_string(self):
        assert clean_markdown("") == ""

    def test_decodes_html_entities(self):
        assert clean_markdown("A&nbsp;&amp;&lt;B&gt;") == "A &<B>"

    def test_strips_wrapper_tags(self):
        assert clean_markdown("<p>hello</p>") == "hello"
        assert clean_markdown("<span>hi</span>") == "hi"

    def test_br_becomes_newline(self):
        assert clean_markdown("a<br>b") == "a\nb"

    def test_smart_quotes_normalized(self):
        assert clean_markdown("“hello”") == '"hello"'
        assert clean_markdown("it’s") == "it's"

    def test_dehyphenation(self):
        assert clean_markdown("hy-\nphen") == "hyphen"

    def test_unicode_invisibles_removed(self):
        assert clean_markdown("a​b﻿c") == "abc"

    def test_whitespace_collapsed(self):
        assert clean_markdown("a   b\t\tc\n\n\n\nd") == "a b c\n\nd"


# ---------------------------------------------------------------------------
# clean_table_markdown
# ---------------------------------------------------------------------------


class TestCleanTableMarkdown:
    def test_empty_string(self):
        assert clean_table_markdown("") == ""

    def test_strips_html_in_cells(self):
        table = "| <span>a</span> | b |\n|---|---|\n| c | d |"
        result = clean_table_markdown(table)
        assert "<span>" not in result
        assert "| a | b |" in result

    def test_drops_empty_trailing_rows(self):
        table = "| a | b |\n| --- | --- |\n| c | d |\n|   |"
        result = clean_table_markdown(table)
        assert result.rstrip().splitlines()[-1] == "| c | d |"

    def test_pads_short_rows(self):
        table = "| a | b | c |\n| --- | --- | --- |\n| x |"
        result = clean_table_markdown(table)
        lines = result.splitlines()
        assert lines[-1].count("|") == 4  # 3 cells + 2 edges = 4 pipes


# ---------------------------------------------------------------------------
# _text_quality_score + _normalize_for_dedup
# ---------------------------------------------------------------------------


class TestTextQualityScore:
    def test_empty(self):
        assert _text_quality_score("") == 0.0

    def test_clean_text(self):
        assert _text_quality_score("hello world") == 1.0

    def test_garbled(self):
        # Half alphanumeric, half symbols
        assert _text_quality_score("abcd!!!!") == 0.5

    def test_ordering(self):
        good = _text_quality_score("the quick brown fox")
        bad = _text_quality_score("!@#$%^&*()")
        assert good > bad


class TestNormalizeForDedup:
    def test_splits_on_whitespace(self):
        assert _normalize_for_dedup("The Quick Brown FOX") == {
            "the",
            "quick",
            "brown",
            "fox",
        }

    def test_strips_punctuation(self):
        assert _normalize_for_dedup("hello, world!") == {"hello", "world"}


# ---------------------------------------------------------------------------
# _dedup_entries
# ---------------------------------------------------------------------------


def _text_entry(page: int, content: str, *, quality_high: bool = True) -> dict:
    """Build a minimal text-type entry for dedup tests."""
    return {
        "document_type": "text",
        "metadata": {
            "content": content,
            "content_metadata": {"page_number": page},
        },
    }


class TestDedupEntries:
    def test_empty_list(self):
        assert _dedup_entries([]) == []

    def test_single_entry(self):
        e = _text_entry(1, "hello world")
        assert _dedup_entries([e]) == [e]

    def test_different_pages_not_dedup(self):
        a = _text_entry(1, "the quick brown fox")
        b = _text_entry(2, "the quick brown fox")
        assert len(_dedup_entries([a, b])) == 2

    def test_same_page_similar_content_dedups(self):
        a = _text_entry(1, "the quick brown fox jumps over the lazy dog")
        b = _text_entry(1, "The quick brown fox jumps over the lazy dog!")
        result = _dedup_entries([a, b])
        assert len(result) == 1

    def test_same_page_different_content_kept(self):
        a = _text_entry(1, "one two three four five")
        b = _text_entry(1, "completely different words here")
        assert len(_dedup_entries([a, b])) == 2

    def test_non_text_entries_passed_through(self):
        image_entry = {
            "document_type": "image",
            "metadata": {
                "image_metadata": {"caption": "chart"},
                "content_metadata": {"page_number": 1},
            },
        }
        result = _dedup_entries([image_entry])
        assert result == [image_entry]


# ---------------------------------------------------------------------------
# results_to_markdown
# ---------------------------------------------------------------------------


class TestResultsToMarkdown:
    def test_empty_results(self):
        assert results_to_markdown([]) == ("", 0)
        assert results_to_markdown([[]]) == ("", 0)

    def test_text_entry(self):
        entry = _text_entry(1, "Hello, world!")
        md, pages = results_to_markdown([[entry]])
        assert "Hello, world!" in md
        assert pages == 1

    def test_page_breaks(self):
        entries = [
            _text_entry(1, "page one text"),
            _text_entry(2, "page two text"),
        ]
        md, pages = results_to_markdown([entries])
        assert "---" in md
        assert pages == 2

    def test_image_with_caption(self):
        entry = {
            "document_type": "image",
            "metadata": {
                "image_metadata": {"caption": "a bar chart"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, pages = results_to_markdown([[entry]])
        assert "*[Image: a bar chart]*" in md
        assert pages == 1

    def test_structured_table(self):
        entry = {
            "document_type": "structured",
            "metadata": {
                "table_metadata": {"table_content": "| a | b |\n|---|---|\n| 1 | 2 |"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, _ = results_to_markdown([[entry]])
        assert "| a | b |" in md

    def test_audio_transcript(self):
        entry = {
            "document_type": "audio",
            "metadata": {
                "audio_metadata": {"audio_transcript": "hello spoken"},
                "content_metadata": {"page_number": 1},
            },
        }
        md, _ = results_to_markdown([[entry]])
        assert "> hello spoken" in md


# ---------------------------------------------------------------------------
# format_single_doc_response
# ---------------------------------------------------------------------------


def _success_result(**overrides) -> IngestResult:
    base: IngestResult = {
        "status": "success",
        "filename": "report.pdf",
        "chunks": 47,
        "failures": 0,
        "pages": 5,
        "collection": "user_uploads",
        "markdown": "# extracted content\n\nparagraph text",
        "error": "",
    }
    base.update(overrides)  # type: ignore[typeddict-item]
    return base


class TestFormatSingleDocResponse:
    def test_failure_returns_error(self):
        result: IngestResult = {
            "status": "failure",
            "filename": "x.pdf",
            "chunks": 0,
            "failures": 0,
            "pages": 0,
            "collection": "",
            "markdown": "",
            "error": "Error: Document not found in storage.",
        }
        out = format_single_doc_response(result)
        assert out == "Error: Document not found in storage."

    def test_success_with_markdown_appends_footer(self):
        out = format_single_doc_response(_success_result())
        assert "extracted content" in out
        assert "1 document indexed" in out
        assert "5 pages" in out
        assert "47 chunks" in out

    def test_success_without_markdown_emits_receipt(self):
        out = format_single_doc_response(_success_result(markdown=""))
        assert out.startswith("✅ Successfully processed")  # ✅
        assert "1 document indexed" in out
        assert "5 pages" in out

    def test_partial_receipt(self):
        result = _success_result(status="partial", failures=3, markdown="")
        out = format_single_doc_response(result)
        assert out.startswith("⚠️ Partially processed")  # ⚠️
        assert "47 chunks successful, 3 failed" in out


# ---------------------------------------------------------------------------
# format_batch_response — includes the Tier 0 regression test
# ---------------------------------------------------------------------------


class TestFormatBatchResponse:
    def test_all_success_emits_frontend_phrases(self):
        """Regression for the batch misclassification bug.

        Before the structured-return refactor, every successful batch document
        was silently classified as failed because `process_document` returned
        the extracted markdown and the batch handler grepped it for
        "Successfully processed". This test locks in the correct behavior:
        structured success results produce a success summary with the
        frontend-parseable phrases.
        """
        successful = [
            {"id": "a.pdf", "chunks": 10, "pages": 2, "status": "success"},
            {"id": "b.pdf", "chunks": 15, "pages": 3, "status": "success"},
            {"id": "c.pdf", "chunks": 20, "pages": 4, "status": "success"},
        ]
        out = format_batch_response(
            total_documents=3,
            successful_documents=successful,
            failed_documents=[],
            total_chunks=45,
            total_pages=9,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Successfully processed all 3 documents" in out
        assert "3 documents indexed" in out
        assert "9 pages" in out
        # per-file entries
        assert "a.pdf" in out and "b.pdf" in out and "c.pdf" in out
        # must NOT contain the failure header
        assert "Failed to process any documents" not in out

    def test_partial_batch(self):
        out = format_batch_response(
            total_documents=3,
            successful_documents=[
                {"id": "a.pdf", "chunks": 10, "pages": 2, "status": "success"}
            ],
            failed_documents=[{"id": "b.pdf", "error": "oops"}],
            total_chunks=10,
            total_pages=2,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Partially completed batch processing" in out
        assert "1 documents indexed" in out
        assert "2 pages" in out
        assert "b.pdf" in out

    def test_all_failed(self):
        out = format_batch_response(
            total_documents=2,
            successful_documents=[],
            failed_documents=[
                {"id": "a.pdf", "error": "boom"},
                {"id": "b.pdf", "error": "bang"},
            ],
            total_chunks=0,
            total_pages=0,
            collection_name="user_uploads",
            chunk_size=1024,
            chunk_overlap=150,
        )
        assert "Failed to process any documents" in out
        assert "a.pdf" in out and "b.pdf" in out


# ---------------------------------------------------------------------------
# html_to_markdown_udf module importability
# ---------------------------------------------------------------------------


class TestHtmlToMarkdownUdfImport:
    def test_module_importable(self):
        """The html_to_markdown_udf module should be importable without errors."""
        import nat_nv_ingest.html_to_markdown_udf as html_mod  # noqa: F401

        assert html_mod is not None
