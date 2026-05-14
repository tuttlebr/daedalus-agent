import { Message } from '@/types/chat';
import { Logger } from '@/utils/logger';

const logger = new Logger('ReplaySanitizer');

export const PRIOR_ASSISTANT_OMITTED_MESSAGE =
  '[Prior assistant response omitted from this backend prompt to prevent replay. ' +
  'Use the surrounding user messages as conversation context. Do not reproduce earlier assistant messages.]';

const INTERNAL_REPLAY_MARKERS = [PRIOR_ASSISTANT_OMITTED_MESSAGE];

function getAssistantContent(message: any): string {
  return message?.role === 'assistant' && typeof message?.content === 'string'
    ? message.content.trim()
    : '';
}

function stripSeparatorsAtStart(content: string): string {
  return content
    .replace(/^(\s*(?:[-*_]{3,})\s*)+/, '')
    .trimStart();
}

function stripSeparatorsAtEnd(content: string): string {
  return content
    .replace(/(\s*(?:[-*_]{3,})\s*)+$/, '')
    .trimEnd();
}

function stripReplayedAssistantBoundary(rawOutput: string, previousContent: string): string {
  const outputStart = rawOutput.trimStart();

  if (outputStart.startsWith(previousContent)) {
    const remainder = outputStart.slice(previousContent.length);
    if (remainder && /^\s/.test(remainder)) {
      const stripped = stripSeparatorsAtStart(remainder);
      if (stripped) return stripped;
    }
  }

  const outputEnd = rawOutput.trimEnd();
  if (outputEnd.endsWith(previousContent)) {
    const remainder = outputEnd.slice(0, outputEnd.length - previousContent.length);
    if (remainder && /\s$/.test(remainder)) {
      const stripped = stripSeparatorsAtEnd(remainder);
      if (stripped) return stripped;
    }
  }

  return rawOutput;
}

// Fuzzy fallback: catches replays where the exact-string boundary check above
// would miss due to incidental whitespace/punctuation differences. Operates on
// alternating word/whitespace tokens (split with capturing group) and only
// strips at a sentence-boundary aligned position, with hard length/word
// thresholds to keep false-positive risk low.

const NATURAL_PREFIX_RE = /^(OK|Okay|Sure|Yes|No|Got it|Understood|Thanks)\b/i;
const FUZZY_MIN_MATCH_WORDS = 8;
const FUZZY_MIN_MATCH_CHARS = 40;
const FUZZY_MIN_PRIOR_CHARS = 40;
const FUZZY_MIN_OUTPUT_CHARS = 80;
const FUZZY_MIN_REMAINDER_CHARS = 20;

function endsSentence(token: string): boolean {
  if (!token) return false;
  const last = token[token.length - 1];
  return last === '.' || last === '!' || last === '?' || last === ':' || last === '\n';
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/);
}

function findFuzzyPrefixMatchLength(output: string, prior: string): number {
  if (prior.length < FUZZY_MIN_PRIOR_CHARS || output.length < FUZZY_MIN_OUTPUT_CHARS) return 0;

  const outTokens = tokenize(output);
  const priorTokens = tokenize(prior);
  const maxIdx = Math.min(outTokens.length, priorTokens.length);

  let charPos = 0;
  let wordCount = 0;
  let lastBoundaryCharPos = 0;
  let lastBoundaryWordCount = 0;

  for (let i = 0; i < maxIdx; i++) {
    const a = outTokens[i];
    const b = priorTokens[i];
    if (a === b) {
      charPos += a.length;
      const isWord = a.trim().length > 0;
      if (isWord) {
        wordCount += 1;
        if (endsSentence(a)) {
          lastBoundaryCharPos = charPos;
          lastBoundaryWordCount = wordCount;
        }
      } else if (a.includes('\n')) {
        lastBoundaryCharPos = charPos;
        lastBoundaryWordCount = wordCount;
      }
      continue;
    }
    // Soft-match on whitespace differences only.
    if (a.trim() === '' && b.trim() === '') {
      charPos += a.length;
      if (a.includes('\n') || b.includes('\n')) {
        lastBoundaryCharPos = charPos;
        lastBoundaryWordCount = wordCount;
      }
      continue;
    }
    break;
  }

  if (lastBoundaryWordCount < FUZZY_MIN_MATCH_WORDS || lastBoundaryCharPos < FUZZY_MIN_MATCH_CHARS) return 0;

  const remainder = stripSeparatorsAtStart(output.slice(lastBoundaryCharPos));
  if (remainder.length < FUZZY_MIN_REMAINDER_CHARS) return 0;

  const matched = output.slice(0, lastBoundaryCharPos);
  if (NATURAL_PREFIX_RE.test(matched) && matched.length < 60) return 0;

  return lastBoundaryCharPos;
}

function findFuzzySuffixMatchLength(output: string, prior: string): number {
  if (prior.length < FUZZY_MIN_PRIOR_CHARS || output.length < FUZZY_MIN_OUTPUT_CHARS) return 0;

  const outTokens = tokenize(output);
  const priorTokens = tokenize(prior);
  const maxIdx = Math.min(outTokens.length, priorTokens.length);

  let charPos = 0;
  let wordCount = 0;
  let lastBoundaryCharPos = 0;
  let lastBoundaryWordCount = 0;

  for (let i = 0; i < maxIdx; i++) {
    const a = outTokens[outTokens.length - 1 - i];
    const b = priorTokens[priorTokens.length - 1 - i];
    if (a === b) {
      charPos += a.length;
      const isWord = a.trim().length > 0;
      if (isWord) wordCount += 1;
      // Suffix boundary: the token preceding this position in `output` ends a
      // sentence, or is a whitespace token containing a newline.
      const prevIdx = outTokens.length - 2 - i;
      const prevTok = prevIdx >= 0 ? outTokens[prevIdx] : '';
      if (prevTok && (endsSentence(prevTok) || prevTok.includes('\n'))) {
        lastBoundaryCharPos = charPos;
        lastBoundaryWordCount = wordCount;
      }
      continue;
    }
    if (a.trim() === '' && b.trim() === '') {
      charPos += a.length;
      continue;
    }
    break;
  }

  if (lastBoundaryWordCount < FUZZY_MIN_MATCH_WORDS || lastBoundaryCharPos < FUZZY_MIN_MATCH_CHARS) return 0;

  const remainder = stripSeparatorsAtEnd(output.slice(0, output.length - lastBoundaryCharPos));
  if (remainder.length < FUZZY_MIN_REMAINDER_CHARS) return 0;

  return lastBoundaryCharPos;
}

function stripFuzzyReplayedAssistantBoundary(rawOutput: string, previousContent: string): string {
  const prefixLen = findFuzzyPrefixMatchLength(rawOutput, previousContent);
  if (prefixLen > 0) {
    const remainder = stripSeparatorsAtStart(rawOutput.slice(prefixLen));
    if (remainder) return remainder;
  }
  const suffixLen = findFuzzySuffixMatchLength(rawOutput, previousContent);
  if (suffixLen > 0) {
    const remainder = stripSeparatorsAtEnd(rawOutput.slice(0, rawOutput.length - suffixLen));
    if (remainder) return remainder;
  }
  return rawOutput;
}

function stripInternalReplayMarkerBoundaries(rawOutput: string): string {
  let normalized = rawOutput;

  for (const marker of INTERNAL_REPLAY_MARKERS) {
    const outputStart = normalized.trimStart();
    if (outputStart.startsWith(marker)) {
      normalized = stripSeparatorsAtStart(outputStart.slice(marker.length));
    }

    const outputEnd = normalized.trimEnd();
    if (outputEnd.endsWith(marker)) {
      normalized = stripSeparatorsAtEnd(
        outputEnd.slice(0, outputEnd.length - marker.length),
      );
    }
  }

  return normalized;
}

export function normalizeAssistantResponseBoundaries(
  rawOutput: string,
  priorMessages: any[] = [],
): string {
  if (!rawOutput) return rawOutput;

  let normalized = stripInternalReplayMarkerBoundaries(rawOutput);
  const hadInternalMarker = normalized !== rawOutput;

  if (Array.isArray(priorMessages)) {
    const previousAssistants = [...priorMessages]
      .reverse()
      .map(getAssistantContent)
      .filter(Boolean);

    for (const previousContent of previousAssistants) {
      let next = stripReplayedAssistantBoundary(normalized, previousContent);
      if (next !== normalized) {
        normalized = next;
        break;
      }
      next = stripFuzzyReplayedAssistantBoundary(normalized, previousContent);
      if (next !== normalized) {
        normalized = next;
        break;
      }
    }
  }

  if (normalized !== rawOutput) {
    const rawTrimStart = rawOutput.trimStart();
    const normTrimStart = normalized.trimStart();
    const rawTrimEnd = rawOutput.trimEnd();
    const normTrimEnd = normalized.trimEnd();
    logger.info('stripped replayed assistant content', {
      rawLength: rawOutput.length,
      normalizedLength: normalized.length,
      strippedChars: rawOutput.length - normalized.length,
      priorAssistantCount: Array.isArray(priorMessages)
        ? priorMessages.filter((m: any) => m?.role === 'assistant').length
        : 0,
      strippedAtStart: rawTrimStart.slice(0, 50) !== normTrimStart.slice(0, 50),
      strippedAtEnd: rawTrimEnd.slice(-50) !== normTrimEnd.slice(-50),
      hadInternalMarker,
    });
  }

  return normalized;
}

export function stripReplayedAssistantPrefix(
  rawOutput: string,
  priorMessages: any[] = [],
): string {
  return normalizeAssistantResponseBoundaries(rawOutput, priorMessages);
}

export function sanitizeConversationAssistantReplays<T extends { messages?: Message[] }>(
  conversation: T,
): T {
  if (!conversation || !Array.isArray(conversation.messages)) {
    return conversation;
  }

  let changed = false;
  const sanitizedMessages: Message[] = [];

  for (const message of conversation.messages) {
    if (message?.role === 'assistant' && typeof message.content === 'string') {
      const content = normalizeAssistantResponseBoundaries(message.content, sanitizedMessages);
      if (content !== message.content) {
        changed = true;
        sanitizedMessages.push({ ...message, content });
        continue;
      }
    }

    sanitizedMessages.push(message);
  }

  if (!changed) return conversation;
  return {
    ...conversation,
    messages: sanitizedMessages,
  };
}

export function sanitizeConversationsAssistantReplays<T extends { messages?: Message[] }>(
  conversations: T[],
): T[] {
  if (!Array.isArray(conversations)) return conversations;

  let changed = false;
  const sanitized = conversations.map((conversation) => {
    const cleaned = sanitizeConversationAssistantReplays(conversation);
    if (cleaned !== conversation) changed = true;
    return cleaned;
  });

  return changed ? sanitized : conversations;
}

export function sanitizeMessageContentFromPriorAssistant(
  content: string,
  priorMessages: Message[] = [],
): string {
  return normalizeAssistantResponseBoundaries(content, priorMessages);
}
