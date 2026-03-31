import {
  getBackendHost,
  buildBackendUrl,
  BACKEND_API_PATH,
  isStreamingEndpoint,
} from '@/utils/app/backendApi';

import { ChatBody } from '@/types/chat';
import { IntermediateStepType } from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';

const logger = new Logger('ChatAPI');

export const config = {
  runtime: 'edge',
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
  // Increase timeout for long-running requests (comprehensive_research_agent can take up to 15 minutes)
  maxDuration: 900, // 15 minutes
};

/**
 * USAGE TRACKING LIMITATION:
 *
 * When streaming with intermediate steps enabled, the backend currently does NOT include
 * cumulative token usage in the final response chunk. This means:
 *
 * - Tool call tokens are NOT tracked (e.g., retriever queries, search API calls)
 * - Intermediate reasoning tokens are NOT tracked
 * - Only the final assistant response tokens are estimated
 *
 * As a workaround, we estimate usage based on request/response text length when no
 * actual usage data is received. This provides approximate tracking but underestimates
 * total usage.
 *
 * BACKEND FIX NEEDED: The backend should aggregate token usage from all intermediate
 * steps and include it in the final streaming chunk when stream_options.include_usage is true.
 */

// Helper function to track usage (Edge runtime compatible)
async function trackUsage(username: string, usage: any): Promise<void> {
  try {
    // Validate usage data before sending
    if (!usage || typeof usage !== 'object') {
      logger.error('invalid usage data (not an object)', usage);
      return;
    }

    const { prompt_tokens, completion_tokens, total_tokens } = usage;

    // Log what we're trying to track
    logger.info('attempting to track usage', {
      username,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      rawUsage: usage
    });

    // Validate that we have numeric values
    if (
      typeof prompt_tokens !== 'number' ||
      typeof completion_tokens !== 'number' ||
      typeof total_tokens !== 'number'
    ) {
      logger.error('invalid usage data (non-numeric values)', {
        prompt_tokens: typeof prompt_tokens,
        completion_tokens: typeof completion_tokens,
        total_tokens: typeof total_tokens,
        rawUsage: usage
      });
      return;
    }

    // Use 127.0.0.1 instead of localhost to avoid IPv6 issues
    // Edge runtime in same container can call Node.js runtime endpoints
    const baseUrl = 'http://127.0.0.1:3000';

    const response = await fetch(`${baseUrl}/api/usage/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, usage }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('failed to track usage', { status: response.status, error: errorText });
    } else {
      const result = await response.json();
      logger.info('usage tracking successful', result);
    }
  } catch (err) {
    logger.error('error tracking usage', err);
  }
}

// Rough token estimation (4 chars ≈ 1 token)
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Basic estimation: ~4 characters per token
  // This is a rough approximation used when backend doesn't provide accurate counts
  return Math.ceil(text.length / 4);
}

// Maximum tokens to send to the backend. The model context window is 86K, but
// the agent adds system prompts, tool schemas, and needs room for the response
// and intermediate tool calls. Keep input well under the limit.
const MAX_INPUT_TOKEN_BUDGET = 40000;

/**
 * Trim message history to fit within the token budget.
 * Strategy: keep all system messages and the latest user message. Drop the
 * oldest non-system messages first until we fit within the budget.
 */
function trimMessagesToFit(messages: any[]): any[] {
  const totalTokens = messages.reduce(
    (sum: number, m: any) => sum + estimateTokens(m.content || ''),
    0,
  );

  if (totalTokens <= MAX_INPUT_TOKEN_BUDGET) return messages;

  logger.warn('message history exceeds token budget, trimming', {
    estimatedTokens: totalTokens,
    budget: MAX_INPUT_TOKEN_BUDGET,
    messageCount: messages.length,
  });

  // Separate system messages (always kept) from conversation messages
  const systemMessages = messages.filter((m: any) => m.role === 'system');
  const conversationMessages = messages.filter((m: any) => m.role !== 'system');

  // Always keep the last user message (the current question)
  if (conversationMessages.length === 0) return messages;

  const systemTokens = systemMessages.reduce(
    (sum: number, m: any) => sum + estimateTokens(m.content || ''),
    0,
  );

  // Drop oldest conversation messages until we fit
  let trimmed = [...conversationMessages];
  let conversationTokens = trimmed.reduce(
    (sum: number, m: any) => sum + estimateTokens(m.content || ''),
    0,
  );

  while (
    trimmed.length > 1 &&
    systemTokens + conversationTokens > MAX_INPUT_TOKEN_BUDGET
  ) {
    const removed = trimmed.shift()!;
    conversationTokens -= estimateTokens(removed.content || '');
  }

  const result = [...systemMessages, ...trimmed];
  logger.info('trimmed message history', {
    originalCount: messages.length,
    trimmedCount: result.length,
    estimatedTokens: systemTokens + conversationTokens,
  });

  return result;
}

// Retrieve image from Redis using imageRef
async function retrieveImageFromRedis(imageRef: any): Promise<string | null> {
  try {
    if (!imageRef?.imageId || !imageRef?.sessionId) {
      logger.error('Invalid imageRef', imageRef);
      return null;
    }

    // Use 127.0.0.1 instead of localhost to avoid IPv6 issues
    const baseUrl = 'http://127.0.0.1:3000';
    const url = `${baseUrl}/api/session/imageStorage?imageId=${imageRef.imageId}&sessionId=${imageRef.sessionId}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'image/*',
      },
    });

    if (!response.ok) {
      logger.error('Failed to retrieve image', { status: response.status, statusText: response.statusText });
      return null;
    }

    // Convert response to base64
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte),
        ''
      )
    );

    logger.info('Successfully retrieved image from Redis', imageRef.imageId);
    return base64;
  } catch (error) {
    logger.error('Error retrieving image from Redis', error);
    return null;
  }
}

// Extract complete JSON objects from a string (handles nested objects)
function extractJsonObjects(text: string): { json: any; startIdx: number; endIdx: number }[] {
  const results: { json: any; startIdx: number; endIdx: number }[] = [];
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        // Found a complete JSON object
        const jsonStr = text.substring(startIdx, i + 1);
        try {
          const parsed = JSON.parse(jsonStr);
          results.push({ json: parsed, startIdx, endIdx: i + 1 });
        } catch (e) {
          // Not valid JSON, ignore
        }
        startIdx = -1;
      }
    }
  }

  return results;
}

const handler = async (req: Request): Promise<Response> => {
  // extract the request body
  let {
    chatCompletionURL = '',
    messages = [],
    additionalProps = {
      enableIntermediateSteps: true,
    },
  } = (await req.json()) as ChatBody;

  // Extract username from additionalProps
  const username = additionalProps?.username || 'anon';

  // Calculate estimated prompt tokens before sending
  const estimatedPromptTokens = messages.reduce((total, msg) => {
    return total + estimateTokens(msg.content || '');
  }, 0);

  logger.info('estimated prompt tokens for request', estimatedPromptTokens);

  // Process messages to ensure attachments are represented as references only
  messages = await Promise.all(messages.map(async (message) => {
    const cleanedMessage = { ...message };

    // Process attachments - ensure references are preserved but no base64 is added to the prompt
    if (cleanedMessage.attachments && Array.isArray(cleanedMessage.attachments)) {
      cleanedMessage.attachments = cleanedMessage.attachments
        .filter(Boolean)
        .map((attachment: any) => {
          if (attachment?.imageRef) {
            return {
              content: '', // Keep content empty to avoid base64 in prompt
              type: attachment.type || 'image',
              imageRef: attachment.imageRef,
              mimeType: attachment.mimeType,
            };
          } else if (attachment?.imageRefs && Array.isArray(attachment.imageRefs)) {
            return {
              content: '', // Keep content empty to avoid base64 in prompt
              type: attachment.type || 'image',
              imageRefs: attachment.imageRefs,
              mimeType: attachment.mimeType,
            };
          } else if (attachment?.videoRef) {
            return {
              content: '',
              type: attachment.type || 'video',
              videoRef: attachment.videoRef,
              mimeType: attachment.mimeType,
            };
          } else if (attachment?.videoRefs && Array.isArray(attachment.videoRefs)) {
            return {
              content: '',
              type: attachment.type || 'video',
              videoRefs: attachment.videoRefs,
              mimeType: attachment.mimeType,
            };
          } else if (attachment?.documentRef) {
            return {
              content: '', // Keep content empty to avoid base64 in prompt
              type: attachment.type || 'document',
              documentRef: attachment.documentRef,
              mimeType: attachment.mimeType,
            };
          }
          return null;
        })
        .filter((att): att is NonNullable<typeof att> => att !== null);

      // Add image references to message content for agent context
      if (cleanedMessage.attachments && cleanedMessage.attachments.length > 0) {
        const imageAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'image');
        if (imageAttachments.length > 0) {
          // Collect all image references (flatten into single array)
          const allImageRefs: any[] = [];
          imageAttachments.forEach((att: any) => {
            if (att.imageRef) {
              allImageRefs.push(att.imageRef);
            } else if (att.imageRefs && Array.isArray(att.imageRefs)) {
              allImageRefs.push(...att.imageRefs);
            }
          });

          if (allImageRefs.length > 0) {
            // Format message clearly for LLM to understand how to call tools
            let imageRefContext = '\n\n[User has attached ';
            if (allImageRefs.length === 1) {
              // Single image: provide clear instructions
              imageRefContext += `1 image. To use this image with tools, pass imageRef=${JSON.stringify(allImageRefs[0])}]`;
            } else {
              // Multiple images: provide clear instructions for array format
              imageRefContext += `${allImageRefs.length} images. To use these images with tools, pass imageRef=${JSON.stringify(allImageRefs)}]`;
            }
            cleanedMessage.content = (cleanedMessage.content || '') + imageRefContext;
            logger.info('Added image reference context to message', {
              imageCount: allImageRefs.length,
              contentLength: cleanedMessage.content.length
            });
          }
        }

        // Add video references to message content for agent context
        const videoAttachments = cleanedMessage.attachments.filter((att: any) => att.type === 'video');
        if (videoAttachments.length > 0) {
          const allVideoRefs: any[] = [];
          videoAttachments.forEach((att: any) => {
            if (att.videoRef) {
              allVideoRefs.push(att.videoRef);
            } else if (att.videoRefs && Array.isArray(att.videoRefs)) {
              allVideoRefs.push(...att.videoRefs);
            }
          });

          if (allVideoRefs.length > 0) {
            let videoRefContext = '\n\n[User has attached ';
            if (allVideoRefs.length === 1) {
              videoRefContext += `1 video. To use this video with tools, pass videoRef=${JSON.stringify(allVideoRefs[0])}]`;
            } else {
              videoRefContext += `${allVideoRefs.length} videos. To use these videos with tools, pass videoRef=${JSON.stringify(allVideoRefs)}]`;
            }
            cleanedMessage.content = (cleanedMessage.content || '') + videoRefContext;
            logger.info('Added video reference context to message', {
              videoCount: allVideoRefs.length,
              contentLength: cleanedMessage.content.length
            });
          }
        }
      }

      if (cleanedMessage.attachments.length === 0) {
        delete cleanedMessage.attachments;
      }
    }

    // Remove any properties that might contain base64
    const keysToRemove = ['inputFileContent', 'inputFileContentCompressed'];
    keysToRemove.forEach((key) => {
      if (key in cleanedMessage) {
        delete (cleanedMessage as any)[key];
      }
    });

    // Check content for base64 and truncate if necessary
    if (
      typeof cleanedMessage.content === 'string' &&
      cleanedMessage.content.length > 10000
    ) {
      logger.warn(
        'Message content truncated due to excessive length (possible base64 leakage)',
      );
      cleanedMessage.content =
        cleanedMessage.content.substring(0, 10000) + '... [content truncated]';
    }

    return cleanedMessage;
  }));

  // Note: Document processing is now handled separately via /api/document/process
  // The frontend processes documents before sending the chat message

  // Strip system messages — the backend's NAT agent owns the system prompt.
  // Sending extra system-role messages causes a 400 from LLMs that require
  // system messages at the beginning (e.g. Qwen, certain NIM endpoints).
  messages = messages.filter((m: any) => m.role !== 'system');

  // Trim message history to fit within the model's context window
  messages = trimMessagesToFit(messages);

  logger.info(
    '/api/chat received messages count',
    Array.isArray(messages) ? messages.length : 'n/a',
  );

  // Check if any message has useDeepThinker flag
  const useDeepThinker = messages.some((msg: any) => msg.metadata?.useDeepThinker === true);
  logger.info('useDeepThinker', useDeepThinker);

  try {
    // Normalize backend URL to in-cluster FQDN and route based on useDeepThinker flag
    const backendHost = getBackendHost(useDeepThinker);
    const defaultStreamUrl = buildBackendUrl({ backendHost });

    try {
      const provided = chatCompletionURL || '';
      if (!provided) {
        chatCompletionURL = defaultStreamUrl;
      } else {
        // Always replace the backend host based on deep thinker flag
        const u = new URL(provided);
        // Extract the path and query params from the provided URL
        const pathAndQuery = u.pathname + u.search;
        // Construct new URL with the correct backend, preserving the original path
        chatCompletionURL = buildBackendUrl({ backendHost, pathOverride: pathAndQuery });
      }
    } catch {
      chatCompletionURL = defaultStreamUrl;
    }
    let payload;
    // for generate end point the request schema is {input_message: "user question"}
    if (chatCompletionURL.includes('generate')) {
      if (
        messages?.length > 0 &&
        messages[messages.length - 1]?.role === 'user'
      ) {
        payload = {
          input_message: messages[messages.length - 1]?.content ?? '',
          user_id: username, // Add user_id for memory tools
          additional_props: additionalProps,
        };
      } else {
        throw new Error(
          'User message not found: messages array is empty or invalid.',
        );
      }
    }

    // for chat end point it is openAI compatible schema
    else {
      const useStreaming = isStreamingEndpoint();
      payload = {
        messages,
        model: 'string',
        temperature: 0,
        max_tokens: 0,
        top_p: 0,
        use_knowledge_base: true,
        top_k: 0,
        collection_name: 'string',
        stop: true,
        stream: useStreaming,  // Match streaming to endpoint configuration
        user_id: username, // Add user_id for memory tools
        additional_props: additionalProps,
        // Request usage data in streaming responses (OpenAI-compatible)
        ...(useStreaming && {
          stream_options: {
            include_usage: true
          },
        }),
      };
    }

    logger.info('making request to', {
      url: chatCompletionURL,
      username,
    });

    logger.info('forwarding chat request to backend', {
      chatCompletionURL,
      payloadSnapshot: Array.isArray(payload?.messages)
        ? payload.messages.map((msg: any) => ({
            role: msg?.role,
            content: msg?.content,
          }))
        : payload,
    });

    let response = await fetch(chatCompletionURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': username,
        // Add backend type header for routing
        'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(payload),
    });

    logger.info('received response from server', response.status);

    if (!response.ok) {
      let errorMessage = await response.text();

      if (errorMessage.includes('<!DOCTYPE html>')) {
        if (errorMessage.includes('404')) {
          errorMessage = '404 - Page not found';
        } else {
          errorMessage =
            'HTML response received from server, which cannot be parsed.';
        }
      }
      const backendLabel = useDeepThinker ? 'deep-thinker' : 'default';
      logger.error('received error response from server', {
        status: response.status,
        backend: backendLabel,
        url: chatCompletionURL,
        error: errorMessage,
      });

      // Provide a specific, actionable message for context-length overflow
      if (
        response.status === 400 &&
        errorMessage.includes('maximum context length')
      ) {
        const userFacingError =
          'This conversation has grown too long for the model to process. ' +
          'Please start a new conversation or clear some history and try again.';
        return new Response(userFacingError, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // For other errors, return a Response object with the error message
      const formattedError = `Something went wrong. Please try again. \n\n<details><summary>Details</summary>Backend: ${backendLabel} (${chatCompletionURL})\nHTTP ${response.status}\nError: ${
        errorMessage || 'Unknown error'
      }</details>`;
      return new Response(formattedError, {
        status: 200, // Return 200 status
        headers: { 'Content-Type': 'text/plain' }, // Set appropriate content type
      });
    }

    // response handling for streaming schema
    if (chatCompletionURL.includes('stream')) {
      logger.info('processing streaming response');
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      const responseStream = new ReadableStream({
        async start(controller) {
          const reader = response?.body?.getReader();
          let buffer = '';
          let counter = 0;
          let usageData: any = null;
          let lastDataTime = Date.now();
          let totalResponseText = ''; // Track total response for token estimation
          let streamClosed = false;
          let receivedDone = false;
          const toolImageRefs: string[] = []; // Track image references from tool outputs
          let lastToolOutput = ''; // Track last function output from intermediate_data for response recovery

          // Keepalive mechanism: Send a space character every 30 seconds to prevent 504 timeouts
          const keepaliveInterval = setInterval(() => {
            const timeSinceLastData = Date.now() - lastDataTime;
            const secondsSinceData = Math.floor(timeSinceLastData / 1000);
            // If no data received in last 25 seconds, send keepalive
            if (timeSinceLastData > 25000) {
              try {
                controller.enqueue(encoder.encode(' '));
                logger.info(`sent keepalive ping (${secondsSinceData}s since last data)`);
              } catch (err) {
                logger.error('keepalive ping failed (stream may be closed)', err);
              }
            }
          }, 30000); // Check every 30 seconds

          try {
            while (true) {
              const result = await reader?.read();
              if (!result) break;
              const { done, value } = result;
              if (done) break;

              lastDataTime = Date.now(); // Update last data time
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(5);
                  if (data.trim() === '[DONE]') {
                    receivedDone = true;
                    clearInterval(keepaliveInterval);

                    // NAT v1.6.0+ sends response only in intermediate_data, not in
                    // data: chunks. Recover the response from the last tool output.
                    if (!totalResponseText.trim() && lastToolOutput) {
                      totalResponseText = lastToolOutput;
                      controller.enqueue(encoder.encode(lastToolOutput));
                      logger.info('recovered response from intermediate_data function output', {
                        outputLength: lastToolOutput.length,
                      });
                    }

                    // Inject image references from tool outputs that weren't included in the LLM response
                    if (toolImageRefs.length > 0) {
                      const missingRefs = toolImageRefs.filter(ref => !totalResponseText.includes(ref));
                      if (missingRefs.length > 0) {
                        const imageContent = '\n\n' + missingRefs.join('\n\n');
                        totalResponseText += imageContent;
                        controller.enqueue(encoder.encode(imageContent));
                        logger.info('injected missing image reference(s) from tool outputs', { count: missingRefs.length });
                      }
                    }

                    if (usageData && username) {
                      trackUsage(username, usageData).catch(err => logger.error('usage tracking failed', err));
                    }
                    streamClosed = true;
                    controller.close();
                    return;
                  }
                  try {
                    const parsed = JSON.parse(data);

                    // Detect backend error objects (e.g. NAT connection errors)
                    if (parsed.error) {
                      const errDetail = typeof parsed.error === 'string'
                        ? parsed.error
                        : parsed.error?.message || JSON.stringify(parsed.error);
                      const backendLabel = useDeepThinker ? 'deep-thinker' : 'default';
                      logger.error('backend returned error in stream', {
                        backend: backendLabel,
                        url: chatCompletionURL,
                        error: errDetail,
                      });
                      const userMessage = `\n\nThe backend encountered an error. Please try again.\n\n<details><summary>Details</summary>Backend: ${backendLabel} (${chatCompletionURL})\nError: ${errDetail}</details>`;
                      controller.enqueue(encoder.encode(userMessage));
                      continue;
                    }

                    // Accept multiple backend response shapes (OpenAI, NAT, custom)
                    // Prefer delta.content (incremental) over message.content (accumulated)
                    // to avoid double-accumulation: the frontend also concatenates chunks,
                    // so forwarding accumulated text causes each response to contain all
                    // prior content compounded.
                    let content =
                      parsed.choices?.[0]?.delta?.content ??
                      parsed.choices?.[0]?.message?.content ??
                      parsed.output ??
                      parsed.answer ??
                      parsed.value ??
                      parsed.text ??
                      parsed.content ??
                      parsed.data?.output ??
                      parsed.data?.content ??
                      '';

                    // Safety net: if only message.content was available (no delta) and
                    // it contains previously-sent text, extract just the new portion.
                    if (content && typeof content === 'string' && totalResponseText
                        && content.length > totalResponseText.length
                        && content.startsWith(totalResponseText)) {
                      content = content.slice(totalResponseText.length);
                    }

                    // Some providers return arrays/objects for content; stringify defensively
                    if (!content && Array.isArray(parsed?.outputs)) {
                      content = parsed.outputs.join('\n');
                    }
                    if (content && typeof content !== 'string') {
                      try {
                        content = JSON.stringify(content);
                      } catch {
                        content = String(content);
                      }
                    }

                    // Debug: Log what fields are in each chunk
                    if (parsed.usage || parsed.choices?.[0]?.finish_reason) {
                      logger.debug('streaming chunk contains', {
                        hasUsage: !!parsed.usage,
                        usage: parsed.usage,
                        finishReason: parsed.choices?.[0]?.finish_reason,
                        hasContent: !!content
                      });
                    }

                    // Extract usage data if available
                    if (parsed.usage) {
                      usageData = parsed.usage;

                      // WORKAROUND: If backend returns prompt_tokens as 0, use our estimate
                      if (usageData.prompt_tokens === 0 && estimatedPromptTokens > 0) {
                        logger.info('backend returned prompt_tokens=0, using estimated value', estimatedPromptTokens);
                        usageData.prompt_tokens = estimatedPromptTokens;
                        // Recalculate total if it seems wrong
                        if (usageData.total_tokens === usageData.completion_tokens) {
                          usageData.total_tokens = estimatedPromptTokens + usageData.completion_tokens;
                        }
                      }

                      logger.info('extracted usage data from streaming chunk', {
                        prompt_tokens: usageData.prompt_tokens,
                        completion_tokens: usageData.completion_tokens,
                        total_tokens: usageData.total_tokens,
                        rawUsage: usageData
                      });
                    }

                    if (content) {
                      // Filter out raw intermediate step JSON that might be sent without proper wrapping
                      let filteredContent = content;

                      // Extract all complete JSON objects from the content
                      const jsonObjects = extractJsonObjects(content);

                      // Filter out intermediate steps
                      const intermediateSteps = jsonObjects.filter(
                        obj => obj.json.type === 'system_intermediate' && obj.json.id
                      );

                      if (intermediateSteps.length > 0) {
                        logger.info(`filtering ${intermediateSteps.length} raw intermediate step(s) from content`);

                        // Remove intermediate steps from the content (reverse order to maintain indices)
                        for (let i = intermediateSteps.length - 1; i >= 0; i--) {
                          const { startIdx, endIdx } = intermediateSteps[i];
                          filteredContent = filteredContent.substring(0, startIdx) + filteredContent.substring(endIdx);
                        }

                        // Transform and forward intermediate steps if enabled
                        if (additionalProps.enableIntermediateSteps === true) {
                          for (const stepData of intermediateSteps) {
                            const payload = stepData.json;

                            // Transform to new intermediate step format
                            const intermediateStep = {
                              parent_id: payload?.parent_id || 'root',
                              function_ancestry: {
                                node_id: payload?.id || `step-${Date.now()}`,
                                parent_id: payload?.parent_id || null,
                                function_name: payload?.name || payload?.type || 'System Step',
                                depth: 0
                              },
                              payload: {
                                event_type: payload?.status === 'completed' ? IntermediateStepType.CUSTOM_END : IntermediateStepType.CUSTOM_START,
                                event_timestamp: payload?.time_stamp || Date.now() / 1000,
                                name: payload?.name || payload?.type || 'System Step',
                                metadata: {
                                  original_payload: payload
                                },
                                data: {
                                  output: payload?.payload || payload?.message || payload?.content || 'Processing step'
                                },
                                UUID: payload?.id || `${Date.now()}-${Math.random()}`
                              }
                            };

                            // Track image references from completed tool steps
                            if (payload?.status === 'completed') {
                              const toolOutput = payload?.payload || payload?.message || payload?.content || '';
                              if (typeof toolOutput === 'string') {
                                const imageRefPattern = /!\[[^\]]*\]\(\/api\/generated-image\/[a-f0-9-]+\)/g;
                                const matches = toolOutput.match(imageRefPattern);
                                if (matches) {
                                  toolImageRefs.push(...matches);
                                  logger.info('captured image reference(s) from tool output', { count: matches.length });
                                }
                              }
                            }

                            const messageString = `<intermediatestep>${JSON.stringify(
                              intermediateStep,
                            )}</intermediatestep>`;
                            controller.enqueue(encoder.encode(messageString));
                          }
                        }
                      }

                      // Only send content if there's something left after filtering
                      if (filteredContent.trim()) {
                        totalResponseText += filteredContent; // Accumulate for token estimation
                        controller.enqueue(encoder.encode(filteredContent));
                      }
                    }
                  } catch (error) {
                    logger.error('error parsing JSON', error);
                  }
                }
                // NAT v1.6.0+ sends intermediate steps via intermediate_data: prefix
                if (line.startsWith('intermediate_data: ')) {
                  const intermediateJson = line.slice('intermediate_data: '.length);
                  try {
                    const parsedStep = JSON.parse(intermediateJson);
                    const isComplete = parsedStep.name?.includes('Complete:');
                    const isWorkflow = parsedStep.name?.includes('<workflow>');

                    // Extract clean tool name: "Function Start: get_memory" → "get_memory"
                    const cleanName = parsedStep.name
                      ?.replace(/^Function (Start|Complete): /, '')
                      .replace(/<|>/g, '') || 'System Step';

                    // Map to proper event types so activity indicator and step
                    // consolidation work correctly
                    let eventType: IntermediateStepType;
                    if (isWorkflow) {
                      eventType = isComplete
                        ? IntermediateStepType.WORKFLOW_END
                        : IntermediateStepType.WORKFLOW_START;
                    } else {
                      eventType = isComplete
                        ? IntermediateStepType.TOOL_END
                        : IntermediateStepType.TOOL_START;
                    }

                    // Forward as intermediate step for the UI
                    if (additionalProps.enableIntermediateSteps === true) {
                      const intermediateStep = {
                        parent_id: parsedStep.parent_id || 'root',
                        function_ancestry: {
                          node_id: parsedStep.id || `step-${Date.now()}`,
                          parent_id: parsedStep.parent_id || null,
                          function_name: cleanName,
                          depth: 0
                        },
                        payload: {
                          event_type: eventType,
                          event_timestamp: Date.now() / 1000,
                          name: cleanName,
                          metadata: { original_payload: parsedStep },
                          data: { output: parsedStep.payload || '' },
                          UUID: parsedStep.id || `${Date.now()}-${Math.random()}`
                        }
                      };

                      // Track image references from completed tool steps
                      if (isComplete && typeof parsedStep.payload === 'string') {
                        const imageRefPattern = /!\[[^\]]*\]\(\/api\/generated-image\/[a-f0-9-]+\)/g;
                        const matches = parsedStep.payload.match(imageRefPattern);
                        if (matches) {
                          toolImageRefs.push(...matches);
                          logger.info('captured image reference(s) from intermediate_data', { count: matches.length });
                        }
                      }

                      const messageString = `<intermediatestep>${JSON.stringify(intermediateStep)}</intermediatestep>`;
                      controller.enqueue(encoder.encode(messageString));
                    }

                    // Extract function output for response recovery (skip workflow wrapper).
                    // Uses string indexing instead of regex because the response can
                    // contain triple-backtick code blocks that break non-greedy matching.
                    if (isComplete && !isWorkflow && typeof parsedStep.payload === 'string') {
                      const marker = '**Function Output:**\n```';
                      const markerIdx = parsedStep.payload.lastIndexOf(marker);
                      if (markerIdx !== -1) {
                        // Skip past the opening fence line (```python, ```json, etc.)
                        const contentStart = parsedStep.payload.indexOf('\n', markerIdx + marker.length);
                        if (contentStart !== -1) {
                          let output = parsedStep.payload.slice(contentStart + 1);
                          // Strip the trailing closing fence (always the last ``` in the payload)
                          const lastFence = output.lastIndexOf('\n```');
                          if (lastFence !== -1) {
                            output = output.slice(0, lastFence);
                          }
                          if (output.trim() && output.trim() !== '[]') {
                            lastToolOutput = output.trim();
                          }
                        }
                      }
                    }
                  } catch (error) {
                    logger.error('error parsing intermediate_data JSON', error);
                  }
                }
              }
            }
            // Stream ended — check if it terminated cleanly
            if (!receivedDone && !streamClosed) {
              const backendLabel = useDeepThinker ? 'deep-thinker' : 'default';
              logger.error('stream ended without [DONE] marker (backend may have crashed)', {
                backend: backendLabel,
                url: chatCompletionURL,
                chunksProcessed: counter,
                responseLength: totalResponseText.length,
              });
              const userMessage = `\n\nThe response was interrupted — the backend encountered an error before finishing. Please try again.\n\n<details><summary>Details</summary>Backend: ${backendLabel} (${chatCompletionURL})\nStream ended unexpectedly</details>`;
              try {
                controller.enqueue(encoder.encode(userMessage));
              } catch (enqueueErr) {
                logger.error('failed to enqueue premature-end message', enqueueErr);
              }
            }
          } catch (error) {
            const backendLabel = useDeepThinker ? 'deep-thinker' : 'default';
            logger.error('stream reading error, closing stream', {
              backend: backendLabel,
              url: chatCompletionURL,
              error,
            });
            if (!streamClosed) {
              const errorMsg = error instanceof Error ? error.message : 'Unknown error';
              const userMessage = `\n\nSomething went wrong while streaming the response. Please try again.\n\n<details><summary>Details</summary>Backend: ${backendLabel} (${chatCompletionURL})\nError: ${errorMsg}</details>`;
              try {
                controller.enqueue(encoder.encode(userMessage));
              } catch (enqueueErr) {
                logger.error('failed to enqueue error message', enqueueErr);
              }
              streamClosed = true;
              controller.close();
            }
          } finally {
            // Clear the keepalive interval
            clearInterval(keepaliveInterval);

            // Track usage if we have it and haven't already
            if (usageData && username) {
              trackUsage(username, usageData).catch(err => logger.error('usage tracking failed (finally)', err));
            } else if (username && estimatedPromptTokens > 0) {
              // FALLBACK: If no usage data received (common with intermediate steps),
              // track estimated usage based on actual request/response
              const estimatedCompletionTokens = estimateTokens(totalResponseText);

              logger.info('no usage data from backend, tracking estimated usage', {
                username,
                estimatedPromptTokens,
                estimatedCompletionTokens,
                responseLength: totalResponseText.length
              });

              // Create estimated usage data
              // NOTE: This is approximate - actual token counts may differ
              const estimatedUsage = {
                prompt_tokens: estimatedPromptTokens,
                completion_tokens: estimatedCompletionTokens,
                total_tokens: estimatedPromptTokens + estimatedCompletionTokens,
              };

              trackUsage(username, estimatedUsage).catch(err => logger.error('estimated usage tracking failed', err));
            }
            logger.info('response processing is completed, closing stream');
            if (!streamClosed) {
              streamClosed = true;
              controller.close();
            }
            reader?.releaseLock();
          }
        },
      });

      return new Response(responseStream);
    }

    // response handling for non straming schema
    else {
      logger.info('processing non streaming response');
      const data = await response.text();
      let parsed = null;

      try {
        parsed = JSON.parse(data);
      } catch (error) {
        logger.error('error parsing JSON response', error);
      }

      // Debug: Log the parsed response to see if usage is included
      logger.debug('parsed response keys', parsed ? Object.keys(parsed) : 'null');
      logger.debug('full parsed response for debugging', JSON.stringify(parsed, null, 2).substring(0, 500));
      logger.debug('usage data in response', parsed?.usage || 'NO USAGE DATA');

      // Extract and track usage if available
      if (parsed?.usage && username) {
        logger.info('found usage data, attempting to track for user', { username, usage: parsed.usage });

        // WORKAROUND: If backend returns prompt_tokens as 0, use our estimate
        if (parsed.usage.prompt_tokens === 0 && estimatedPromptTokens > 0) {
          logger.info('backend returned prompt_tokens=0, using estimated value', estimatedPromptTokens);
          parsed.usage.prompt_tokens = estimatedPromptTokens;
          // Recalculate total if it seems wrong
          if (parsed.usage.total_tokens === parsed.usage.completion_tokens) {
            parsed.usage.total_tokens = estimatedPromptTokens + parsed.usage.completion_tokens;
          }
        }

        await trackUsage(username, parsed.usage);
        logger.info('usage tracking call completed for user', username);
      } else {
        logger.info('no usage data to track - details', {
          hasUsage: !!parsed?.usage,
          usage: parsed?.usage,
          username,
          parsedType: typeof parsed,
        });
      }

      // Safely extract content with proper checks
      const content =
        parsed?.output || // Check for `output`
        parsed?.answer || // Check for `answer`
        parsed?.value || // Check for `value`
        (Array.isArray(parsed?.choices)
          ? parsed.choices[0]?.message?.content
          : null) || // Safely check `choices[0]`
        parsed || // Fallback to the entire `parsed` object
        data; // Final fallback to raw `data`

      if (content) {
        logger.info('response processing is completed');
        return new Response(content);
      } else {
        logger.error('error parsing response');
        return new Response(response.body || data);
      }
    }
  } catch (error) {
    const backendLabel = useDeepThinker ? 'deep-thinker' : 'default';
    logger.error('error while making request', {
      backend: backendLabel,
      url: chatCompletionURL,
      error,
    });
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const formattedError = `Something went wrong. Please try again. \n\n<details><summary>Details</summary>Backend: ${backendLabel} (${chatCompletionURL})\nError: ${errorMessage}</details>`;
    return new Response(formattedError, { status: 200 });
  }
};

export default handler;
