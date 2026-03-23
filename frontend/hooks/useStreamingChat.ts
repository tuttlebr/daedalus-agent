/**
 * useStreamingChat - Manages SSE streaming for chat responses
 *
 * Features:
 * - SSE stream connection and reading
 * - Chunk parsing with intermediate step extraction
 * - Intermediate step buffering for incomplete tags
 * - Done signal detection
 * - AbortController management for stream cancellation
 * - Automatic response extraction from intermediate steps when content is empty
 */

import { useCallback, useRef } from 'react';
import { Message } from '@/types/chat';
import {
  IntermediateStep,
  IntermediateStepType,
  getEventState,
  IntermediateStepState,
} from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';

const logger = new Logger('StreamingChat');

export interface StreamChunk {
  /** Raw text content from this chunk */
  text: string;
  /** Parsed intermediate steps from this chunk */
  intermediateSteps: IntermediateStep[];
  /** Whether stream is complete */
  done: boolean;
  /** Whether done signal was detected */
  doneSignalReceived: boolean;
}

export interface StreamState {
  /** Accumulated raw text */
  rawText: string;
  /** Display text (sanitized) */
  displayText: string;
  /** All intermediate steps accumulated */
  intermediateSteps: IntermediateStep[];
  /** Whether streaming is active */
  isStreaming: boolean;
  /** Any error that occurred */
  error: Error | null;
}

export interface UseStreamingChatOptions {
  /** Function to sanitize content for display (e.g., remove inline images) */
  sanitizeContent?: (content: string) => string;
  /** Function to merge intermediate steps */
  mergeSteps?: (
    existing: IntermediateStep[],
    incoming: IntermediateStep[],
    completionTimestamp?: number
  ) => IntermediateStep[];
  /** Callback when chunk is received */
  onChunk?: (chunk: StreamChunk, state: StreamState) => void;
  /** Callback when stream completes */
  onComplete?: (state: StreamState) => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
}

export interface UseStreamingChatReturn {
  /**
   * Start streaming from an endpoint
   */
  startStream: (
    endpoint: string,
    body: object,
    controller?: AbortController
  ) => Promise<StreamState>;

  /**
   * Stop the current stream
   */
  stopStream: () => void;

  /**
   * Parse a chunk of SSE data
   */
  parseChunk: (chunk: string, buffer: string) => {
    text: string;
    intermediateSteps: IntermediateStep[];
    remainingBuffer: string;
    doneSignalReceived: boolean;
  };

  /**
   * Extract response content from intermediate steps
   * Used when main content is empty but steps contain the response
   */
  extractResponseFromSteps: (steps: IntermediateStep[]) => {
    content: string;
    source: string;
  } | null;

  /**
   * Check if stream is currently active
   */
  isStreaming: boolean;
}

/**
 * Default content sanitizer (removes inline images for display)
 */
function defaultSanitizeContent(content?: string): string {
  if (!content) return '';

  // Remove inline base64 images and reference tags
  return content
    .replace(/data:image\/[^;]+;base64,[^\s]*/g, '[image]')
    .replace(/<image_reference>[^<]*<\/image_reference>/g, '')
    .replace(/<video_reference>[^<]*<\/video_reference>/g, '');
}

/**
 * Default step merger (simple concat, assumes caller handles deduplication)
 */
function defaultMergeSteps(
  existing: IntermediateStep[] = [],
  incoming: IntermediateStep[] = []
): IntermediateStep[] {
  return [...existing, ...incoming];
}

export function useStreamingChat(
  options: UseStreamingChatOptions = {}
): UseStreamingChatReturn {
  const {
    sanitizeContent = defaultSanitizeContent,
    mergeSteps = defaultMergeSteps,
    onChunk,
    onComplete,
    onError,
  } = options;

  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const activeControllerRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);

  /**
   * Parse intermediate steps from chunk
   */
  const parseIntermediateSteps = useCallback((text: string): IntermediateStep[] => {
    const steps: IntermediateStep[] = [];
    const messages = text.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];

    for (const message of messages) {
      try {
        const jsonString = message
          .replace('<intermediatestep>', '')
          .replace('</intermediatestep>', '')
          .trim();
        const rawStep = JSON.parse(jsonString);

        // New format (payload.event_type)
        if (rawStep?.payload?.event_type) {
          steps.push(rawStep as IntermediateStep);
        }
        // Old format (type: 'system_intermediate') - transform
        else if (rawStep?.type === 'system_intermediate') {
          const newFormatStep: IntermediateStep = {
            parent_id: rawStep.parent_id || 'root',
            function_ancestry: {
              node_id: rawStep.id || `step-${Date.now()}`,
              parent_id: rawStep.parent_id || null,
              function_name: rawStep.content?.name || 'Unknown',
              depth: 0,
            },
            payload: {
              event_type:
                rawStep.status === 'completed'
                  ? IntermediateStepType.CUSTOM_END
                  : IntermediateStepType.CUSTOM_START,
              event_timestamp: rawStep.time_stamp || Date.now() / 1000,
              name: rawStep.content?.name || 'Step',
              metadata: { original_data: rawStep },
              data: { output: rawStep.content?.payload || '' },
              UUID: rawStep.id || `${Date.now()}-${Math.random()}`,
            },
          };
          steps.push(newFormatStep);
        }
      } catch (error) {
        logger.error('Failed to parse intermediate step JSON', error);
      }
    }

    // Filter out CHUNK events (streaming tokens)
    return steps.filter((step) => {
      if (!step?.payload?.event_type) return false;
      return getEventState(step.payload.event_type) !== IntermediateStepState.CHUNK;
    });
  }, []);

  /**
   * Parse a chunk of SSE data
   */
  const parseChunk = useCallback(
    (
      chunk: string,
      buffer: string
    ): {
      text: string;
      intermediateSteps: IntermediateStep[];
      remainingBuffer: string;
      doneSignalReceived: boolean;
    } => {
      // Combine with buffer
      let text = buffer + chunk;
      let remainingBuffer = '';

      // Check for done signal
      const doneSignalReceived = /data:\s*\[DONE\]/.test(text);
      if (doneSignalReceived) {
        text = text.replace(/data:\s*\[DONE\]/g, '');
      }

      // Check for incomplete intermediate step tag
      const lastOpenTag = text.lastIndexOf('<intermediatestep>');
      const lastCloseTag = text.lastIndexOf('</intermediatestep>');

      if (lastOpenTag > lastCloseTag) {
        // Buffer incomplete tag for next iteration
        remainingBuffer = text.substring(lastOpenTag);
        text = text.substring(0, lastOpenTag);
      }

      // Parse intermediate steps
      const intermediateSteps = parseIntermediateSteps(text);

      // Remove intermediate step tags from visible content
      text = text.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');

      return {
        text,
        intermediateSteps,
        remainingBuffer,
        doneSignalReceived,
      };
    },
    [parseIntermediateSteps]
  );

  /**
   * Extract response from intermediate steps (fallback when content is empty)
   */
  const extractResponseFromSteps = useCallback(
    (
      steps: IntermediateStep[]
    ): { content: string; source: string } | null => {
      const endEventTypes = [
        IntermediateStepType.LLM_END,
        IntermediateStepType.WORKFLOW_END,
        IntermediateStepType.TASK_END,
        IntermediateStepType.FUNCTION_END,
        IntermediateStepType.CUSTOM_END,
      ];

      // Search from the end for the most recent END event with content
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (!endEventTypes.includes(step?.payload?.event_type)) {
          continue;
        }

        // Strategy 1: data.output
        const output = step?.payload?.data?.output;
        if (output && typeof output === 'string' && output.trim()) {
          return { content: output, source: 'data.output' };
        }

        // Strategy 2: metadata.chat_responses
        const chatResponse = step?.payload?.metadata?.chat_responses;
        if (chatResponse && typeof chatResponse === 'string' && chatResponse.trim()) {
          return { content: chatResponse, source: 'metadata.chat_responses' };
        }

        // Strategy 3: data.result
        const result = (step?.payload?.data as any)?.result;
        if (result && typeof result === 'string' && result.trim()) {
          return { content: result, source: 'data.result' };
        }

        // Strategy 4: data.content
        const content = (step?.payload?.data as any)?.content;
        if (content && typeof content === 'string' && content.trim()) {
          return { content, source: 'data.content' };
        }

        // Strategy 5: data.response
        const response = (step?.payload?.data as any)?.response;
        if (response) {
          if (typeof response === 'string' && response.trim()) {
            return { content: response, source: 'data.response' };
          }
          if (typeof response === 'object' && response.content) {
            return { content: response.content, source: 'data.response.content' };
          }
        }
      }

      return null;
    },
    []
  );

  /**
   * Stop the current stream
   */
  const stopStream = useCallback(() => {
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }

    if (activeReaderRef.current) {
      try {
        activeReaderRef.current.cancel();
      } catch (e) {
        // Reader may already be cancelled
      }
      activeReaderRef.current = null;
    }

    isStreamingRef.current = false;
  }, []);

  /**
   * Start streaming from an endpoint
   */
  const startStream = useCallback(
    async (
      endpoint: string,
      body: object,
      controller?: AbortController
    ): Promise<StreamState> => {
      // Cancel any existing stream
      stopStream();

      const ctrl = controller || new AbortController();
      activeControllerRef.current = ctrl;
      isStreamingRef.current = true;

      const state: StreamState = {
        rawText: '',
        displayText: '',
        intermediateSteps: [],
        isStreaming: true,
        error: null,
      };

      try {
        logger.info('Starting SSE stream', { endpoint });

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = response.body;
        if (!data) {
          throw new Error('No response body received');
        }

        const reader = data.getReader();
        activeReaderRef.current = reader;
        const decoder = new TextDecoder();

        let done = false;
        let buffer = '';

        while (!done && isStreamingRef.current) {
          // Check abort signal
          if (ctrl.signal.aborted) {
            await reader.cancel();
            break;
          }

          let readResult;
          try {
            readResult = await reader.read();
          } catch (error: any) {
            if (error?.name === 'AbortError' || ctrl.signal.aborted) {
              break;
            }
            throw error;
          }

          const { value, done: doneReading } = readResult;
          done = doneReading;

          if (done || !value) {
            break;
          }

          const chunk = decoder.decode(value);
          const parsed = parseChunk(chunk, buffer);
          buffer = parsed.remainingBuffer;

          if (parsed.doneSignalReceived) {
            done = true;
          }

          // Update state
          state.rawText += parsed.text;
          state.displayText = sanitizeContent(state.rawText);
          state.intermediateSteps = mergeSteps(
            state.intermediateSteps,
            parsed.intermediateSteps
          );

          // Notify chunk received
          if (onChunk) {
            onChunk(
              {
                text: parsed.text,
                intermediateSteps: parsed.intermediateSteps,
                done,
                doneSignalReceived: parsed.doneSignalReceived,
              },
              state
            );
          }
        }

        // Clean up reader
        try {
          await reader.cancel();
        } catch (e) {
          // Ignore
        }

        // If content is empty but we have steps, try to extract response
        if (!state.displayText.trim() && state.intermediateSteps.length > 0) {
          const extracted = extractResponseFromSteps(state.intermediateSteps);
          if (extracted) {
            logger.info('Extracted response from intermediate steps', {
              source: extracted.source,
              length: extracted.content.length,
            });
            state.rawText = extracted.content;
            state.displayText = sanitizeContent(extracted.content);
          }
        }

        state.isStreaming = false;
        isStreamingRef.current = false;

        if (onComplete) {
          onComplete(state);
        }

        return state;
      } catch (error: any) {
        state.error = error;
        state.isStreaming = false;
        isStreamingRef.current = false;

        if (error?.name !== 'AbortError') {
          logger.error('Stream error', error);
          if (onError) {
            onError(error);
          }
        }

        return state;
      }
    },
    [parseChunk, sanitizeContent, mergeSteps, extractResponseFromSteps, onChunk, onComplete, onError, stopStream]
  );

  return {
    startStream,
    stopStream,
    parseChunk,
    extractResponseFromSteps,
    isStreaming: isStreamingRef.current,
  };
}
