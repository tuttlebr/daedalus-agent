import logging
import os
import re

import redis
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from nat_helpers.identity import resolve_authenticated_user_id
from nat_helpers.image_utils import fetch_vtt_from_redis
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# Safety bounds to prevent a single oversized upload from blowing up memory or
# stalling the event loop before the HTTP timeout applies (DoS for co-tenants).
# Reject any transcript larger than this (in bytes) before parsing.
MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024  # ~10 MB
# Stop parsing after this many entries to bound the parse loop.
MAX_TRANSCRIPT_ENTRIES = 100_000
# Truncate the consolidated transcript to this many chars before embedding it
# in the LLM prompt.
MAX_CONSOLIDATED_CHARS = 500_000  # ~500 KB


def check_transcript_size(vtt_text: str) -> str | None:
    """
    Reject an oversized transcript before parsing.

    Returns a human-readable error string if the transcript exceeds
    ``MAX_TRANSCRIPT_BYTES`` (measured as UTF-8 bytes), otherwise ``None``.
    """
    size_bytes = len(vtt_text.encode("utf-8", errors="ignore"))
    if size_bytes > MAX_TRANSCRIPT_BYTES:
        return (
            f"Error: transcript exceeds the {MAX_TRANSCRIPT_BYTES // (1024 * 1024)} MB "
            f"size limit ({size_bytes} bytes). Please upload a smaller transcript."
        )
    return None


def truncate_for_prompt(text: str, max_chars: int = MAX_CONSOLIDATED_CHARS) -> str:
    """
    Truncate consolidated transcript text to a safe size for the LLM prompt.

    Appends a clear truncation marker when the text is shortened so the model
    knows the transcript was cut off.
    """
    if len(text) <= max_chars:
        return text
    marker = "\n\n[transcript truncated due to length]"
    return text[:max_chars] + marker


class VttInterpreterFunctionConfig(
    FunctionBaseConfig,
    name="vtt_interpreter",
):
    """
    Configuration for VTT interpreter function.
    Processes VTT (WebVTT) transcript text into structured meeting notes.
    """

    api_endpoint: str = Field(
        "http://localhost:8000",
        description="Base URL for the LLM API endpoint",
    )
    timeout: float = Field(300.0, description="HTTP timeout in seconds")
    api_key: str | None = Field(
        default=None,
        description="Optional API key. Falls back to NVIDIA_API_KEY env var.",
    )
    model: str = Field(
        "meta/llama-3.1-405b-instruct",
        description="LLM model to use for transcript analysis",
    )
    redis_url: str = Field(
        "redis://redis:6379",
        description="Redis connection URL for retrieving uploaded transcripts by id.",
    )


class VttInterpreterInput(BaseModel):
    """Input model for the VTT interpreter function."""

    model_config = ConfigDict(extra="forbid")

    vtt_id: str | None = Field(
        None,
        description="Id of an uploaded transcript stored in Redis. Preferred for "
        "uploaded VTT/SRT files: the tool fetches the transcript itself instead of "
        "receiving the full text through the model. Requires session_id.",
    )
    session_id: str | None = Field(
        None,
        description="Session id that scopes the uploaded transcript. Required when "
        "vtt_id is provided.",
    )
    transcript_text: str | None = Field(
        None,
        description="Raw VTT/SRT transcript text. Use only for transcripts pasted "
        "directly into the conversation; for uploaded files pass vtt_id instead.",
    )
    user_instructions: str | None = Field(
        None,
        description="Optional user instructions for how to process the transcript. "
        "When provided, the output is tailored to the user's specific request "
        "(e.g. 'just list the action items', 'what was discussed about the database migration?'). "
        "When omitted, produces default structured meeting notes with four sections.",
    )


class VttTranscriptEntry:
    """Represents a single entry in a VTT transcript."""

    def __init__(self, timestamp: str, speaker: str, text: str):
        self.timestamp = timestamp
        self.speaker = speaker
        self.text = text

    def __repr__(self):
        return (
            f"VttTranscriptEntry({self.timestamp}, {self.speaker}, {self.text[:50]}...)"
        )


def parse_vtt_transcript(
    vtt_text: str, max_entries: int = MAX_TRANSCRIPT_ENTRIES
) -> list[VttTranscriptEntry]:
    """
    Parse VTT transcript text into structured entries.

    Args:
        vtt_text: Raw VTT transcript text
        max_entries: Stop parsing once this many entries are collected, to
            bound the parse loop for pathologically large inputs.

    Returns:
        List of VttTranscriptEntry objects
    """
    entries = []
    lines = vtt_text.strip().split("\n")

    i = 0
    while i < len(lines):
        if len(entries) >= max_entries:
            logger.warning(
                "Transcript entry cap (%d) reached; truncating parse.", max_entries
            )
            break

        line = lines[i].strip()

        # Skip empty lines, WEBVTT header, and UUID lines
        if not line or line == "WEBVTT" or re.match(r"^[0-9a-f-]+/\d+-\d+$", line):
            i += 1
            continue

        # Look for timestamp lines (format: 00:00:03.408 --> 00:00:03.768)
        timestamp_pattern = (
            r"(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})"
        )
        if re.match(timestamp_pattern, line):
            timestamp = line
            i += 1

            # Collect all content lines until we hit another timestamp or empty line
            content_lines = []
            while i < len(lines) and lines[i].strip():
                content_line = lines[i].strip()
                # Stop if we encounter another timestamp
                if re.match(timestamp_pattern, content_line):
                    break
                # Stop if we encounter a UUID line
                if re.match(r"^[0-9a-f-]+/\d+-\d+$", content_line):
                    break
                content_lines.append(content_line)
                i += 1

            # Process the collected content
            if content_lines:
                full_content = " ".join(content_lines)

                # Extract speaker name from <v Speaker>text</v> format
                speaker_pattern = r"<v\s+([^>]+)>(.+?)</v>"
                match = re.search(speaker_pattern, full_content)

                if match:
                    speaker = match.group(1).strip()
                    text = match.group(2).strip()
                    entries.append(VttTranscriptEntry(timestamp, speaker, text))
                else:
                    # Fallback for lines without speaker tags - clean up any remaining tags
                    clean_content = re.sub(r"<[^>]*>", "", full_content).strip()
                    if clean_content:
                        entries.append(
                            VttTranscriptEntry(timestamp, "Unknown", clean_content)
                        )
        else:
            i += 1

    return entries


def consolidate_transcript_entries(entries: list[VttTranscriptEntry]) -> str:
    """
    Consolidate VTT entries into a readable transcript format.

    Args:
        entries: List of VttTranscriptEntry objects

    Returns:
        Consolidated transcript text with speaker labels
    """
    if not entries:
        return ""

    # Group consecutive entries by speaker to avoid repetitive speaker labels
    consolidated_text = []
    current_speaker = None
    current_text_parts = []

    for entry in entries:
        if entry.speaker != current_speaker:
            # Finalize previous speaker's text
            if current_speaker and current_text_parts:
                consolidated_text.append(
                    f"\n**{current_speaker}:** {' '.join(current_text_parts)}"
                )

            # Start new speaker
            current_speaker = entry.speaker
            current_text_parts = [entry.text]
        else:
            # Continue with same speaker
            current_text_parts.append(entry.text)

    # Add final speaker's text
    if current_speaker and current_text_parts:
        consolidated_text.append(
            f"\n**{current_speaker}:** {' '.join(current_text_parts)}"
        )

    return "\n".join(consolidated_text).strip()


def extract_unique_speakers(entries: list[VttTranscriptEntry]) -> set[str]:
    """Extract unique speaker names from transcript entries."""
    return {entry.speaker for entry in entries if entry.speaker != "Unknown"}


@register_function(config_type=VttInterpreterFunctionConfig)
async def vtt_interpreter_function(
    config: VttInterpreterFunctionConfig,
    builder: Builder,  # noqa: ARG001
):
    # Get API key
    api_key = config.api_key or os.getenv("NVIDIA_API_KEY") or "not-used"

    # Initialize OpenAI client pointing to the LLM endpoint
    openai_client = AsyncOpenAI(
        base_url=config.api_endpoint,
        api_key=api_key,
        timeout=config.timeout,
    )

    # Redis client for retrieving uploaded transcripts by id, so large
    # transcripts are never copied through the model as a tool-call argument.
    redis_client = redis.from_url(config.redis_url, decode_responses=False)

    async def interpret_vtt_transcript(
        transcript_text: str | None = None,
        user_instructions: str | None = None,
        vtt_id: str | None = None,
        session_id: str | None = None,
        user_id: str | None = None,
    ) -> str:
        """
        Process a VTT/SRT transcript according to the user's instructions.

        The transcript may be supplied two ways: pass ``vtt_id`` (plus
        ``session_id``) for an uploaded file — the tool fetches the transcript
        from Redis itself — or pass ``transcript_text`` for a transcript pasted
        directly into the conversation. Prefer ``vtt_id`` for uploads so large
        transcripts are not pushed through the model.

        When user_instructions are provided, the transcript is processed according
        to those specific instructions (e.g. summarize, extract action items, answer
        a question about the content, list decisions, etc.).

        When no instructions are provided, produces default structured meeting notes
        with four sections: Attendees, Business Updates, Technical Updates, Action Items.

        Args:
            transcript_text: Raw VTT or SRT transcript text (for pasted transcripts)
            user_instructions: Optional instructions for how to process the transcript
            vtt_id: Id of an uploaded transcript stored in Redis
            session_id: Session id scoping the uploaded transcript (with vtt_id)
            user_id: Deprecated direct-call identity assertion. The LLM-facing
                schema omits it; HTTP requests use the trusted NAT context.

        Returns:
            Processed transcript output in markdown format
        """
        try:
            effective_user_id: str | None = None
            if vtt_id or user_id:
                effective_user_id = resolve_authenticated_user_id(user_id)

            # Prefer the uploaded-transcript ref: fetch from Redis rather than
            # receiving the full transcript through the model.
            if vtt_id:
                transcript_text, fetch_error = await fetch_vtt_from_redis(
                    redis_client, session_id, vtt_id, effective_user_id
                )
                if fetch_error:
                    return fetch_error

            if not transcript_text or not transcript_text.strip():
                return (
                    "Error: No transcript provided. Pass vtt_id (with session_id) "
                    "for an uploaded transcript, or transcript_text for a pasted one."
                )

            # Reject oversized transcripts before parsing so a multi-GB upload
            # can't blow up memory / stall the event loop for co-tenants.
            size_error = check_transcript_size(transcript_text)
            if size_error:
                logger.warning("Rejecting oversized VTT transcript.")
                return size_error

            # Parse the VTT transcript
            logger.info("Parsing VTT transcript...")
            entries = parse_vtt_transcript(transcript_text)

            if not entries:
                return "Error: No valid transcript entries found in the VTT text."

            # Extract speakers and consolidate text
            speakers = extract_unique_speakers(entries)
            consolidated_transcript = consolidate_transcript_entries(entries)
            # Bound the text embedded in the LLM prompt to a safe size.
            consolidated_transcript = truncate_for_prompt(consolidated_transcript)

            logger.info(
                f"Parsed {len(entries)} transcript entries with {len(speakers)} speakers"
            )

            # Build prompts based on whether user provided specific instructions
            if user_instructions:
                system_prompt = """Role: meeting transcript analyst.

Goal: process the transcript according to the user's request using only transcript evidence.

Constraints:
- Include only information explicitly stated in the transcript.
- If the request asks about something not covered in the transcript, say so directly.
- Do not invent attendees, decisions, dates, owners, or action items.

Output: clear, professional markdown suitable for business documentation. Stop when the user's requested artifact is complete."""

                user_prompt = f"""Here is a meeting transcript:

TRANSCRIPT:
{consolidated_transcript}

USER REQUEST:
{user_instructions}

Process the transcript according to the user's request above. Only use information explicitly stated in the transcript."""

            else:
                system_prompt = """Role: meeting secretary creating professional notes from transcripts.

1. **Attendees** - List the meeting participants/speakers
2. **Business Updates** - Strategic, business-related points suitable for executive leadership summary
3. **Technical Updates** - Technical discussion points appropriate for both executive and technical leadership
4. **Action Items** - Specific follow-up tasks with assignee names and deadlines (when mentioned)

Goal: organize the transcript into exactly the four sections above.

Constraints:
- Include only information explicitly stated in the transcript.
- If no information exists for a section, write "None mentioned" or "No specific items discussed".
- For action items, list only tasks explicitly assigned to someone or mentioned as follow-ups.
- Do not assume deadlines, decisions, attendees, or owners that are not stated.

Output: clean markdown with clear section headers. Stop when all four sections are complete."""

                user_prompt = f"""Please analyze this meeting transcript and create structured meeting notes:

TRANSCRIPT:
{consolidated_transcript}

Please organize this into the four required sections, being careful not to add any information not explicitly stated in the transcript."""

            logger.info(
                f"Sending transcript analysis request to {config.api_endpoint} with model {config.model}"
            )

            # Make the chat completion request
            response = await openai_client.chat.completions.create(
                model=config.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )

            # Extract the response content
            if response.choices and len(response.choices) > 0:
                meeting_notes = response.choices[0].message.content
                logger.info("Successfully generated meeting notes from VTT transcript")
                return meeting_notes

            logger.error("Unexpected response format: %s", response)
            return "Error: Unexpected response format from the language model."

        except Exception as e:
            logger.error(
                "Error during VTT transcript interpretation: %s", str(e), exc_info=True
            )
            return f"Error: {str(e)}"

    try:
        # Register the function
        logger.info("Registering function interpret_vtt_transcript")

        description = (
            "Processes VTT (WebVTT) or SRT meeting transcripts according to the user's instructions. "
            "Can summarize, extract action items, answer questions about the content, list decisions, "
            "identify what a specific person said, or any other analysis the user requests. "
            "For an uploaded transcript, pass vtt_id and session_id (from the attachment instruction) "
            "and the tool fetches the transcript itself — do NOT paste the transcript text. "
            "The backend derives transcript ownership from the authenticated request; never pass user_id. "
            "For a transcript pasted directly into the chat, pass transcript_text. "
            "Pass any specific user asks as user_instructions. "
            "When no specific instructions are provided, produces default structured meeting notes "
            "with four sections: Attendees, Business Updates, Technical Updates, and Action Items. "
            "Only extracts information explicitly mentioned in the transcript without adding or "
            "inferring new details. Returns professionally formatted output in markdown."
        )

        function_info = FunctionInfo.from_fn(
            interpret_vtt_transcript,
            description=description,
            input_schema=VttInterpreterInput,
        )
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up vtt_interpreter workflow.")
