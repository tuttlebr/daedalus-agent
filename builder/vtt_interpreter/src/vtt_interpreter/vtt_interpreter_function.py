import logging
import os
import re

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


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
    max_tokens: int = Field(
        4096,
        description="Maximum number of tokens in the response",
    )


class VttInterpreterInput(BaseModel):
    """Input model for the VTT interpreter function."""

    transcript_text: str = Field(
        ..., description="The raw VTT transcript text to be processed"
    )
    user_instructions: str | None = Field(
        None,
        description="Optional user instructions for how to process the transcript. "
        "When provided, the output is tailored to the user's specific request "
        "(e.g. 'just list the action items', 'what was discussed about the database migration?'). "
        "When omitted, produces default structured meeting notes with four sections.",
    )
    max_tokens: int | None = Field(
        None, description="Maximum number of tokens in the response"
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


def parse_vtt_transcript(vtt_text: str) -> list[VttTranscriptEntry]:
    """
    Parse VTT transcript text into structured entries.

    Args:
        vtt_text: Raw VTT transcript text

    Returns:
        List of VttTranscriptEntry objects
    """
    entries = []
    lines = vtt_text.strip().split("\n")

    i = 0
    while i < len(lines):
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

    async def interpret_vtt_transcript(
        transcript_text: str,
        user_instructions: str | None = None,
        max_tokens: int | None = None,
    ) -> str:
        """
        Process a VTT/SRT transcript according to the user's instructions.

        When user_instructions are provided, the transcript is processed according
        to those specific instructions (e.g. summarize, extract action items, answer
        a question about the content, list decisions, etc.).

        When no instructions are provided, produces default structured meeting notes
        with four sections: Attendees, Business Updates, Technical Updates, Action Items.

        Args:
            transcript_text: Raw VTT or SRT transcript text
            user_instructions: Optional instructions for how to process the transcript
            max_tokens: Maximum number of tokens in the response

        Returns:
            Processed transcript output in markdown format
        """
        try:
            if not transcript_text or not transcript_text.strip():
                return "Error: No transcript text provided."

            # Parse the VTT transcript
            logger.info("Parsing VTT transcript...")
            entries = parse_vtt_transcript(transcript_text)

            if not entries:
                return "Error: No valid transcript entries found in the VTT text."

            # Extract speakers and consolidate text
            speakers = extract_unique_speakers(entries)
            consolidated_transcript = consolidate_transcript_entries(entries)

            logger.info(
                f"Parsed {len(entries)} transcript entries with {len(speakers)} speakers"
            )

            # Build prompts based on whether user provided specific instructions
            if user_instructions:
                system_prompt = """You are an expert at analyzing meeting transcripts. The user has provided specific instructions for how they want this transcript processed. Follow their instructions precisely.

CRITICAL INSTRUCTIONS:
- Do NOT make up or infer any information that is not explicitly stated in the transcript
- Only include information that is clearly mentioned in the conversation
- If the user asks about something not covered in the transcript, say so explicitly
- Use clear, professional language suitable for business documentation
- Format your response in clean markdown"""

                user_prompt = f"""Here is a meeting transcript:

TRANSCRIPT:
{consolidated_transcript}

USER REQUEST:
{user_instructions}

Process the transcript according to the user's request above. Only use information explicitly stated in the transcript."""

            else:
                system_prompt = """You are an expert meeting secretary who creates professional meeting notes from transcripts. Your task is to analyze the provided meeting transcript and organize the information into exactly four sections:

1. **Attendees** - List the meeting participants/speakers
2. **Business Updates** - Strategic, business-related points suitable for executive leadership summary
3. **Technical Updates** - Technical discussion points appropriate for both executive and technical leadership
4. **Action Items** - Specific follow-up tasks with assignee names and deadlines (when mentioned)

CRITICAL INSTRUCTIONS:
- Do NOT make up or infer any information that is not explicitly stated in the transcript
- Only include information that is clearly mentioned in the conversation
- If no information exists for a section, write "None mentioned" or "No specific items discussed"
- For action items, only list tasks that are explicitly assigned to someone or mentioned as follow-ups
- Do not assume or add deadlines that aren't specifically stated
- Use clear, professional language suitable for business documentation

Format your response in clean markdown with clear section headers."""

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
                max_tokens=max_tokens if max_tokens is not None else config.max_tokens,
                temperature=0.1,  # Low temperature for consistent, factual output
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
            "Processes VTT (WebVTT) or SRT transcript text according to the user's instructions. "
            "Can summarize, extract action items, answer questions about the content, list decisions, "
            "identify what a specific person said, or any other analysis the user requests. "
            "When no specific instructions are provided, produces default structured meeting notes "
            "with four sections: Attendees, Business Updates, Technical Updates, and Action Items. "
            "Only extracts information explicitly mentioned in the transcript without adding or "
            "inferring new details. Returns professionally formatted output in markdown."
        )

        function_info = FunctionInfo.from_fn(
            interpret_vtt_transcript,
            description=description,
        )
        yield function_info
    except GeneratorExit:
        logger.warning("Function exited early!")
    finally:
        logger.info("Cleaning up vtt_interpreter workflow.")
