"""Unit tests for vtt_interpreter utility functions.

Tests cover the pure-Python helpers that don't require the NAT framework
or an actual LLM call: parse_vtt_transcript, consolidate_transcript_entries,
extract_unique_speakers, and VttTranscriptEntry.
"""

from vtt_interpreter.vtt_interpreter_function import (
    VttTranscriptEntry,
    consolidate_transcript_entries,
    extract_unique_speakers,
    parse_vtt_transcript,
)

# ---------------------------------------------------------------------------
# VttTranscriptEntry
# ---------------------------------------------------------------------------


class TestVttTranscriptEntry:
    def test_creation_stores_fields(self):
        entry = VttTranscriptEntry(
            "00:00:01.000 --> 00:00:02.000", "Alice", "Hello world"
        )
        assert entry.timestamp == "00:00:01.000 --> 00:00:02.000"
        assert entry.speaker == "Alice"
        assert entry.text == "Hello world"

    def test_repr_contains_class_name(self):
        entry = VttTranscriptEntry(
            "00:00:01.000 --> 00:00:02.000", "Alice", "Hello world"
        )
        assert "VttTranscriptEntry" in repr(entry)

    def test_repr_contains_timestamp(self):
        entry = VttTranscriptEntry("00:00:01.000 --> 00:00:02.000", "Bob", "Hi")
        assert "00:00:01.000 --> 00:00:02.000" in repr(entry)

    def test_repr_contains_speaker(self):
        entry = VttTranscriptEntry("ts", "Charlie", "Some text")
        assert "Charlie" in repr(entry)

    def test_repr_truncates_text(self):
        long_text = "a" * 200
        entry = VttTranscriptEntry("ts", "Speaker", long_text)
        # repr shows first 50 chars with "..."
        assert "..." in repr(entry)


# ---------------------------------------------------------------------------
# parse_vtt_transcript
# ---------------------------------------------------------------------------


class TestParseVttTranscript:
    def test_empty_string(self):
        assert parse_vtt_transcript("") == []

    def test_whitespace_only(self):
        assert parse_vtt_transcript("   \n\n   ") == []

    def test_webvtt_header_only(self):
        assert parse_vtt_transcript("WEBVTT\n\n") == []

    def test_single_entry_with_speaker_tag(self):
        vtt = (
            "WEBVTT\n\n" "00:00:01.000 --> 00:00:02.000\n" "<v Alice>Hello world</v>\n"
        )
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        assert entries[0].speaker == "Alice"
        assert entries[0].text == "Hello world"
        assert "00:00:01.000" in entries[0].timestamp

    def test_single_entry_without_speaker_tag(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nJust plain text\n"
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        assert entries[0].speaker == "Unknown"
        assert entries[0].text == "Just plain text"

    def test_multiple_entries(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "<v Alice>Hello</v>\n"
            "\n"
            "00:00:02.000 --> 00:00:03.000\n"
            "<v Bob>World</v>\n"
        )
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 2
        assert entries[0].speaker == "Alice"
        assert entries[1].speaker == "Bob"

    def test_skips_uuid_lines(self):
        vtt = (
            "WEBVTT\n\n"
            "abc123/1234-5678\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "<v Alice>Hello</v>\n"
        )
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        assert entries[0].speaker == "Alice"

    def test_skips_webvtt_header_line(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>Hi</v>\n"
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        # The WEBVTT line itself should not appear as content
        assert entries[0].text == "Hi"

    def test_multiline_content_joined(self):
        vtt = "WEBVTT\n\n" "00:00:01.000 --> 00:00:02.000\n" "Line one\n" "Line two\n"
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        full_text = entries[0].text
        assert "Line one" in full_text
        assert "Line two" in full_text

    def test_html_tags_stripped_for_unknown_speaker(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "<b>Bold</b> and <i>italic</i>\n"
        )
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        assert "<b>" not in entries[0].text
        assert "Bold" in entries[0].text

    def test_empty_content_after_timestamp_skipped(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n"
        entries = parse_vtt_transcript(vtt)
        assert entries == []

    def test_speaker_name_with_spaces(self):
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "<v John Smith>Good morning</v>\n"
        )
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1
        assert entries[0].speaker == "John Smith"
        assert entries[0].text == "Good morning"

    def test_non_timestamp_lines_skipped(self):
        vtt = "WEBVTT\n\nsome random line\n00:00:01.000 --> 00:00:02.000\n<v A>Hi</v>\n"
        entries = parse_vtt_transcript(vtt)
        assert len(entries) == 1

    def test_content_stops_at_next_timestamp(self):
        """Line 104 branch: inner loop stops when next timestamp found mid-content."""
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "First line\n"
            "00:00:03.000 --> 00:00:04.000\n"  # another timestamp inside content
            "<v Alice>Hello</v>\n"
        )
        entries = parse_vtt_transcript(vtt)
        # First entry should only have "First line", not the next timestamp's content
        assert len(entries) >= 1
        first = entries[0]
        assert "00:00:03" not in first.text

    def test_content_stops_at_uuid_inside_content(self):
        """Line 107 branch: inner loop stops when UUID line found mid-content."""
        vtt = (
            "WEBVTT\n\n"
            "00:00:01.000 --> 00:00:02.000\n"
            "First line\n"
            "abc123/1234-5678\n"  # UUID inside content block
        )
        entries = parse_vtt_transcript(vtt)
        # Should still produce one entry with "First line"
        assert len(entries) == 1
        assert "First line" in entries[0].text


# ---------------------------------------------------------------------------
# consolidate_transcript_entries
# ---------------------------------------------------------------------------


class TestConsolidateTranscriptEntries:
    def test_empty_list(self):
        assert consolidate_transcript_entries([]) == ""

    def test_single_entry(self):
        entries = [VttTranscriptEntry("ts", "Alice", "Hello")]
        result = consolidate_transcript_entries(entries)
        assert "**Alice:**" in result
        assert "Hello" in result

    def test_consecutive_same_speaker_merged(self):
        entries = [
            VttTranscriptEntry("ts1", "Alice", "Hello"),
            VttTranscriptEntry("ts2", "Alice", "World"),
        ]
        result = consolidate_transcript_entries(entries)
        assert result.count("**Alice:**") == 1
        assert "Hello" in result
        assert "World" in result

    def test_speaker_change_creates_new_block(self):
        entries = [
            VttTranscriptEntry("ts1", "Alice", "Hello"),
            VttTranscriptEntry("ts2", "Bob", "Hi there"),
        ]
        result = consolidate_transcript_entries(entries)
        assert "**Alice:**" in result
        assert "**Bob:**" in result

    def test_alternating_speakers(self):
        entries = [
            VttTranscriptEntry("ts1", "Alice", "A1"),
            VttTranscriptEntry("ts2", "Bob", "B1"),
            VttTranscriptEntry("ts3", "Alice", "A2"),
        ]
        result = consolidate_transcript_entries(entries)
        # Alice appears in two separate blocks
        assert result.count("**Alice:**") == 2
        assert result.count("**Bob:**") == 1

    def test_result_is_stripped(self):
        entries = [VttTranscriptEntry("ts", "Alice", "Hello")]
        result = consolidate_transcript_entries(entries)
        assert result == result.strip()

    def test_unknown_speaker_included(self):
        entries = [VttTranscriptEntry("ts", "Unknown", "Some text")]
        result = consolidate_transcript_entries(entries)
        assert "**Unknown:**" in result
        assert "Some text" in result


# ---------------------------------------------------------------------------
# extract_unique_speakers
# ---------------------------------------------------------------------------


class TestExtractUniqueSpeakers:
    def test_empty_list(self):
        assert extract_unique_speakers([]) == set()

    def test_single_speaker(self):
        entries = [VttTranscriptEntry("ts", "Alice", "Hello")]
        assert extract_unique_speakers(entries) == {"Alice"}

    def test_duplicate_speakers_deduplicated(self):
        entries = [
            VttTranscriptEntry("ts1", "Alice", "Hello"),
            VttTranscriptEntry("ts2", "Alice", "Again"),
        ]
        assert extract_unique_speakers(entries) == {"Alice"}

    def test_multiple_unique_speakers(self):
        entries = [
            VttTranscriptEntry("ts1", "Alice", "Hello"),
            VttTranscriptEntry("ts2", "Bob", "Hi"),
            VttTranscriptEntry("ts3", "Charlie", "Hey"),
        ]
        result = extract_unique_speakers(entries)
        assert result == {"Alice", "Bob", "Charlie"}

    def test_unknown_speaker_excluded(self):
        entries = [
            VttTranscriptEntry("ts1", "Unknown", "text"),
            VttTranscriptEntry("ts2", "Alice", "hello"),
        ]
        result = extract_unique_speakers(entries)
        assert "Unknown" not in result
        assert "Alice" in result

    def test_all_unknown_returns_empty(self):
        entries = [
            VttTranscriptEntry("ts1", "Unknown", "a"),
            VttTranscriptEntry("ts2", "Unknown", "b"),
        ]
        assert extract_unique_speakers(entries) == set()

    def test_returns_set_type(self):
        entries = [VttTranscriptEntry("ts", "Alice", "hi")]
        result = extract_unique_speakers(entries)
        assert isinstance(result, set)
