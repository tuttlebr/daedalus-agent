import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, getPublisher, sessionKey, jsonGet, jsonSet, jsonSetWithExpiry, jsonDel, setStreamingState, clearStreamingState } from '../session/redis';
import { publishStreamingState, publishConversationUpdate } from '@/utils/sync/publish';
import { v4 as uuidv4 } from 'uuid';
import { Message } from '@/types/chat';
import { IntermediateStepType } from '@/types/intermediateSteps';
import { Logger } from '@/utils/logger';
import { getBackendHost, buildBackendUrl, isStreamingEndpoint } from '@/utils/app/backendApi';

const logger = new Logger('AsyncJob');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '150mb',  // Support large document processing payloads
    },
  },
  maxDuration: 900, // 15 minutes
};

interface AsyncJobRequest {
  jobId: string;
  messages: any[];
  chatCompletionURL: string;
  additionalProps: any;
  userId: string;
  conversationId?: string;
  conversationName?: string;
}

interface AsyncJobStatus {
  jobId: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  partialResponse?: string;
  fullResponse?: string;
  intermediateSteps?: any[];
  error?: string;
  progress?: number;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  finalizedAt?: number;  // Timestamp when all operations are complete
}

const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const redis = getRedis();

  if (req.method === 'POST') {
    // Create new async job
    try {
      const { messages, chatCompletionURL, additionalProps, userId, conversationId, conversationName } = req.body;

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid messages' });
      }

      const jobId = uuidv4();

      // Store job request
      const jobRequest: AsyncJobRequest = {
        jobId,
        messages,
        chatCompletionURL,
        additionalProps,
        userId: userId || 'anon',
        conversationId,
        conversationName,
      };

      const requestKey = sessionKey(['async-job-request', jobId]);
      await jsonSetWithExpiry(requestKey, jobRequest, JOB_EXPIRY_SECONDS);

      // Initialize job status
      const jobStatus: AsyncJobStatus = {
        jobId,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        conversationId,
      };

      const statusKey = sessionKey(['async-job-status', jobId]);
      await jsonSetWithExpiry(statusKey, jobStatus, JOB_EXPIRY_SECONDS);

      // Trigger async processing (non-blocking)
      processJobAsync(jobId).catch(err => {
        logger.error('Error in async job processing', err);
      });

      return res.status(200).json({ jobId, status: 'pending' });
    } catch (error) {
      logger.error('Error creating async job', error);
      return res.status(500).json({ error: 'Failed to create job' });
    }
  } else if (req.method === 'GET') {
    // Check job status
    const { jobId } = req.query;

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'Invalid job ID' });
    }

    try {
      const statusKey = sessionKey(['async-job-status', jobId]);
      const jobStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

      if (!jobStatus) {
        return res.status(404).json({ error: 'Job not found' });
      }

      return res.status(200).json(jobStatus);
    } catch (error) {
      logger.error('Error fetching job status', error);
      return res.status(500).json({ error: 'Failed to fetch job status' });
    }
  } else if (req.method === 'DELETE') {
    // Cancel job
    const { jobId } = req.query;

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({ error: 'Invalid job ID' });
    }

    try {
      const requestKey = sessionKey(['async-job-request', jobId]);
      const statusKey = sessionKey(['async-job-status', jobId]);

      await Promise.all([
        jsonDel(requestKey),
        jsonDel(statusKey),
      ]);

      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('Error canceling job', error);
      return res.status(500).json({ error: 'Failed to cancel job' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}

// Helper function to add intermediate steps with deduplication
function addIntermediateSteps(existingSteps: any[], newSteps: any[], jobId: string): any[] {
  const stepsMap = new Map<string, any>();

  // Add existing steps to map
  existingSteps.forEach(step => {
    if (step?.payload?.UUID) {
      stepsMap.set(step.payload.UUID, step);
    }
  });

  // Add or update with new steps
  let addedCount = 0;
  let updatedCount = 0;

  newSteps.forEach(step => {
    if (step?.payload?.UUID) {
      if (stepsMap.has(step.payload.UUID)) {
        updatedCount++;
      } else {
        addedCount++;
      }
      stepsMap.set(step.payload.UUID, step);
    }
  });

  if (addedCount > 0 || updatedCount > 0) {
    logger.info(`Job ${jobId}: Added ${addedCount} new steps, updated ${updatedCount} existing steps. Total: ${stepsMap.size}`);
  }

  // Return array sorted by timestamp
  return Array.from(stepsMap.values()).sort((a, b) =>
    (a.payload?.event_timestamp || 0) - (b.payload?.event_timestamp || 0)
  );
}

// Process job asynchronously
async function processJobAsync(jobId: string): Promise<void> {
  const redis = getRedis();
  const requestKey = sessionKey(['async-job-request', jobId]);
  const statusKey = sessionKey(['async-job-status', jobId]);

  try {
    // Get job request
    const jobRequest = await jsonGet(requestKey) as AsyncJobRequest | null;
    if (!jobRequest) {
      throw new Error('Job request not found');
    }

    // Update status to streaming
    await updateJobStatus(jobId, {
      status: 'streaming',
      updatedAt: Date.now(),
    });

    // Set streaming state and publish to other sessions
    const userId = jobRequest.userId || 'anon';
    if (jobRequest.conversationId) {
      await setStreamingState(userId, jobRequest.conversationId, jobId);
      await publishStreamingState(userId, jobRequest.conversationId, true, jobId);
      logger.info(`Job ${jobId}: Published streaming_started for conversation ${jobRequest.conversationId}`);
    }

    const { messages, chatCompletionURL, additionalProps } = jobRequest;

    // Process messages to add image references to content (same as regular chat endpoint)
    const processedMessages = await Promise.all((messages || []).map(async (message: any) => {
      const cleanedMessage = { ...message };

      // Process attachments - add image references to message content for agent context
      if (cleanedMessage.attachments && Array.isArray(cleanedMessage.attachments)) {
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
            logger.info(`Job ${jobId}: Added image reference context to message`, {
              imageCount: allImageRefs.length,
              contentLength: cleanedMessage.content.length
            });
          }
        }
      }

      return cleanedMessage;
    }));

    const messagesWithContext = processedMessages;

    // Determine backend URL - uses centralized config from backendApi.ts
    const useDeepThinker = additionalProps?.useDeepThinker || false;
    const isDocumentProcessing = additionalProps?.isDocumentProcessing || false;
    const backendHost = getBackendHost(useDeepThinker);

    // Document processing always uses the non-streaming /chat endpoint
    const endpoint = isDocumentProcessing
      ? buildBackendUrl({ backendHost, pathOverride: '/chat' })
      : buildBackendUrl({ backendHost });

    logger.info(`Job ${jobId}: Using backend endpoint: ${endpoint}`, { isDocumentProcessing });

    // Construct payload matching the regular chat endpoint format
    // Document processing uses non-streaming; regular chat uses configured endpoint
    const useStreaming = isDocumentProcessing ? false : isStreamingEndpoint();
    const payload = {
      messages: messagesWithContext,
      model: 'string',
      temperature: 0,
      max_tokens: 0,
      top_p: 0,
      use_knowledge_base: true,
      top_k: 0,
      collection_name: 'string',
      stop: true,
      stream: useStreaming,  // Match streaming to endpoint configuration
      enable_intermediate_steps: additionalProps?.enableIntermediateSteps ?? true,  // Enable intermediate steps
      additionalProp1: {},
      ...(useStreaming && {
        stream_options: {
          include_usage: true,
        },
      }),
    };

    // Make request to backend
    logger.info(`Job ${jobId}: Sending request`, {
      messageCount: messagesWithContext?.length,
      stream: payload.stream,
      useDeepThinker,
      isDocumentProcessing
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(useStreaming && { 'Accept': 'text/event-stream' }),
        'x-user-id': additionalProps?.username || 'anon',
        'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(payload),
    });

    logger.info(`Job ${jobId}: Received response`, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Job ${jobId}: Backend error`, errorText);
      throw new Error(`Backend returned ${response.status}: ${response.statusText} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullText = '';
    let intermediateSteps: any[] = [];
    let buffer = '';
    let chunkCount = 0;
    let totalBytesReceived = 0;
    let lastConversationSaveTime = 0;
    const CONVERSATION_SAVE_INTERVAL = 5000; // Save at most once every 5 seconds
    const MAX_MEMORY_BUFFER = 10 * 1024 * 1024; // 10MB max buffer size
    const CHUNK_FLUSH_SIZE = 1024 * 1024; // Flush to Redis every 1MB

    logger.info(`Job ${jobId}: Starting to read response stream`);

    let streamComplete = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          logger.info(`Job ${jobId}: Stream reading completed. Total bytes: ${totalBytesReceived}`);
          break;
        }

        totalBytesReceived += value?.length || 0;

        // Decode chunk and add to buffer
        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;

        // Log first chunk for debugging
        if (chunkCount === 0 && chunkText) {
          logger.info(`Job ${jobId}: First chunk preview: ${chunkText.substring(0, 200)}`);
          // Check if it's SSE format
          if (chunkText.includes('data: ')) {
            logger.info(`Job ${jobId}: Detected SSE format`);
          } else {
            logger.info(`Job ${jobId}: Not SSE format - appears to be JSON`);
          }
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue; // Skip empty lines

          // Debug: Log all lines to see what we're receiving
          if (intermediateSteps.length === 0 && line.trim()) {
            logger.debug(`Job ${jobId}: Line received: ${line.substring(0, 150)}`);
          }

          // Specifically check for intermediate_data lines
          if (line.includes('intermediate_data:') || line.includes('intermediate_step') || line.includes('intermediateStep')) {
            logger.debug(`Job ${jobId}: Found potential intermediate step line`);
          }

          // Log non-SSE formatted lines for debugging
          if (!line.startsWith('data: ') && !line.startsWith('intermediate_data: ')) {
            logger.debug(`Job ${jobId}: Non-SSE line detected: ${line.substring(0, 100)}`);

            // Try to parse as direct JSON response (non-SSE format)
            try {
              const parsed = JSON.parse(line);

              // Check for direct content or OpenAI format
              const content =
                parsed.content ||
                parsed.choices?.[0]?.message?.content ||
                parsed.choices?.[0]?.delta?.content ||
                parsed.response ||
                parsed.text ||
                '';

              if (content) {
                logger.info(`Job ${jobId}: Found content in non-SSE format`);
                fullText += content;
                chunkCount++;
              }

            // Check for intermediate steps in non-SSE format
            if (parsed.intermediate_steps || parsed.intermediateSteps) {
              const steps = parsed.intermediate_steps || parsed.intermediateSteps;
              if (Array.isArray(steps)) {
                logger.info(`Job ${jobId}: Found ${steps.length} intermediate steps in non-SSE format`);
                intermediateSteps = addIntermediateSteps(intermediateSteps, steps, jobId);
              }
            }

            // Also check for intermediatestep tags in content (for legacy format)
            if (typeof line === 'string' && line.includes('<intermediatestep>')) {
              const stepMatches = line.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];
              for (const match of stepMatches) {
                try {
                  const jsonString = match.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
                  const step = JSON.parse(jsonString);
                  if (step?.payload?.event_type) {
                    intermediateSteps = addIntermediateSteps(intermediateSteps, [step], jobId);
                  }
                } catch (err) {
                  logger.error(`Job ${jobId}: Failed to parse intermediate step`, err);
                }
              }
              // Extract content without intermediate step tags
              const cleanedLine = line.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');
              if (cleanedLine.trim()) {
                fullText += cleanedLine + '\n';
                chunkCount++;
              }
              continue; // Skip normal processing since we handled it
            }
            } catch (parseErr) {
              // Not JSON, might be plain text
              if (line.trim()) {
                logger.info(`Job ${jobId}: Treating as plain text response`);
                fullText += line + '\n';
                chunkCount++;
              }
            }
            continue;
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim(); // Remove "data: " prefix

            if (data === '[DONE]') {
              logger.info(`Job ${jobId}: SSE streaming complete signal received`);
              streamComplete = true;
              break;
            }

            try {
              const parsed = JSON.parse(data);

              // Check if this data chunk contains intermediate steps
              if (parsed.intermediate_steps || parsed.intermediateSteps) {
                logger.debug(`Job ${jobId}: Found intermediate steps in data: event`, parsed.intermediate_steps || parsed.intermediateSteps);
                const steps = parsed.intermediate_steps || parsed.intermediateSteps;
                if (Array.isArray(steps)) {
                  logger.info(`Job ${jobId}: Processing ${steps.length} intermediate steps from data chunk`);
                  intermediateSteps = addIntermediateSteps(intermediateSteps, steps, jobId);
                }
              }

              // Check for intermediate steps in the choices object
              if (parsed.choices?.[0]?.message?.intermediateSteps || parsed.choices?.[0]?.message?.intermediate_steps) {
                const choiceSteps = parsed.choices[0].message.intermediateSteps || parsed.choices[0].message.intermediate_steps;
                if (Array.isArray(choiceSteps)) {
                  logger.info(`Job ${jobId}: Processing ${choiceSteps.length} intermediate steps in message`);
                  intermediateSteps = addIntermediateSteps(intermediateSteps, choiceSteps, jobId);
                }
              }

              // Extract content from OpenAI-compatible response
              let content =
                parsed.choices?.[0]?.message?.content ||
                parsed.choices?.[0]?.delta?.content ||
                '';

              if (content) {
                // Check if content contains intermediate step tags
                if (content.includes('<intermediatestep>')) {
                  const stepMatches = content.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];
                  for (const match of stepMatches) {
                    try {
                      const jsonString = match.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
                      const step = JSON.parse(jsonString);
                      if (step?.payload?.event_type) {
                        intermediateSteps = addIntermediateSteps(intermediateSteps, [step], jobId);
                      }
                    } catch (err) {
                      logger.error(`Job ${jobId}: Failed to parse intermediate step from SSE`, err);
                    }
                  }
                  // Remove intermediate step tags from content
                  content = content.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');
                }

                fullText += content;
                chunkCount++;

                // Publish token to Redis for WS streaming
                if (jobRequest.conversationId) {
                  const tokenChannel = `user:${jobRequest.userId}:chat:${jobRequest.conversationId}:tokens`;
                  getPublisher().publish(tokenChannel, JSON.stringify({
                    type: 'chat_token',
                    conversationId: jobRequest.conversationId,
                    jobId,
                    content,
                  })).catch(() => {});
                }

                // Update job status every 5 chunks for responsive UI
                if (chunkCount % 5 === 0) {
                  await updateJobStatus(jobId, {
                    status: 'streaming',
                    partialResponse: fullText,
                    intermediateSteps,
                    progress: Math.min(90, chunkCount * 2),
                    updatedAt: Date.now(),
                  });

                  // Save partial conversation to Redis for recovery, but throttle to prevent excessive writes
                  const now = Date.now();
                  if (jobRequest.conversationId && (now - lastConversationSaveTime) > CONVERSATION_SAVE_INTERVAL) {
                    try {
                      const partialMessage: Message = {
                        role: 'assistant',
                        content: fullText,
                        intermediateSteps: intermediateSteps || [],
                      };
                      const partialConversation = {
                        id: jobRequest.conversationId,
                        name: jobRequest.conversationName,
                        messages: [...(jobRequest.messages || []), partialMessage],
                        updatedAt: Date.now(),
                        isPartial: true,
                      };
                      const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
                      await jsonSet(conversationKey, '$', partialConversation);
                      lastConversationSaveTime = now;
                      logger.debug(`Job ${jobId}: Saved partial conversation (throttled)`);
                    } catch (err) {
                      logger.error(`Failed to save partial conversation`, err);
                    }
                  }
                }
              }
            } catch (err) {
              logger.error(`Job ${jobId}: Error parsing JSON chunk`, err);
            }
          } else if (line.startsWith('intermediate_data: ')) {
            // Handle intermediate steps
            const data = line.slice(19).trim(); // Remove "intermediate_data: " prefix

            if (data !== '[DONE]') {
              try {
                logger.debug(`Job ${jobId}: Received intermediate_data: ${data.substring(0, 200)}`);
                const payload = JSON.parse(data);

                // Check if it's already in the correct format
                let intermediateStep;
                if (payload?.payload?.event_type) {
                  intermediateStep = payload;
                  logger.debug(`Job ${jobId}: Intermediate step already formatted: ${payload.payload.name || payload.payload.event_type}`);
                } else {
                  // Transform to intermediate step format
                  intermediateStep = {
                    parent_id: payload?.parent_id || 'root',
                    function_ancestry: {
                      node_id: payload?.id || `step-${Date.now()}`,
                      parent_id: payload?.parent_id || null,
                      function_name: payload?.name || payload?.content?.name || 'Unknown',
                      depth: 0
                    },
                    payload: {
                      event_type: payload?.status === 'completed' ? IntermediateStepType.CUSTOM_END : IntermediateStepType.CUSTOM_START,
                      event_timestamp: payload?.time_stamp || payload?.timestamp || Date.now() / 1000,
                      name: payload?.name || payload?.content?.name || 'Step',
                      metadata: {
                        original_payload: payload
                      },
                      data: {
                        output: payload?.payload || payload?.content?.payload || 'No details'
                      },
                      UUID: payload?.UUID || payload?.id || `${Date.now()}-${Math.random()}`
                    }
                  };
                  logger.debug(`Job ${jobId}: Transformed intermediate step: ${intermediateStep.payload.name}`);
                }

                // Add step with deduplication
                intermediateSteps = addIntermediateSteps(intermediateSteps, [intermediateStep], jobId);

                // Publish intermediate step to Redis for WS streaming
                if (jobRequest.conversationId) {
                  const tokenChannel = `user:${jobRequest.userId}:chat:${jobRequest.conversationId}:tokens`;
                  getPublisher().publish(tokenChannel, JSON.stringify({
                    type: 'chat_intermediate_step',
                    conversationId: jobRequest.conversationId,
                    jobId,
                    step: intermediateStep,
                  })).catch(() => {});
                }

                // Update job status with new intermediate step for UI feedback
                logger.info(`Job ${jobId}: Total intermediate steps: ${intermediateSteps.length}`);
                await updateJobStatus(jobId, {
                  status: 'streaming',
                  partialResponse: fullText,
                  intermediateSteps: [...intermediateSteps], // Clone array for reactivity
                  progress: Math.min(90, chunkCount * 2),
                  updatedAt: Date.now(),
                });

                // REMOVED: Don't save conversation on every intermediate step!
                // This was causing excessive Redis writes. The conversation will be saved:
                // 1. Every 5 chunks for content updates
                // 2. Once at the very end when complete
                // The job status already has the intermediate steps for UI updates
              } catch (err) {
                logger.error(`Job ${jobId}: Error parsing intermediate step`, err);
              }
            }
          }
        }

        if (streamComplete) {
          try {
            await reader.cancel();
          } catch (cancelError) {
            logger.debug(`Job ${jobId}: Stream already closed on cancel`, cancelError);
          }
          break;
        }
      }
    } catch (readError) {
      logger.error(`Job ${jobId}: Error reading stream`, readError);
      throw readError;
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      logger.info(`Job ${jobId}: Processing remaining buffer: ${buffer.substring(0, 100)}`);
      try {
        const parsed = JSON.parse(buffer);

        // Debug: Log the structure of the response
        logger.debug(`Job ${jobId}: Complete response structure`, {
          hasChoices: !!parsed.choices,
          hasIntermediateSteps: !!(parsed.intermediate_steps || parsed.intermediateSteps),
          messageKeys: parsed.choices?.[0]?.message ? Object.keys(parsed.choices[0].message) : [],
          topLevelKeys: Object.keys(parsed).slice(0, 10)
        });

        // Check for intermediate steps at various levels
        if (parsed.intermediate_steps || parsed.intermediateSteps) {
          const steps = parsed.intermediate_steps || parsed.intermediateSteps;
          if (Array.isArray(steps)) {
                logger.info(`Job ${jobId}: Processing ${steps.length} intermediate steps in final buffer`);
            intermediateSteps = addIntermediateSteps(intermediateSteps, steps, jobId);
          }
        }

        if (parsed.choices?.[0]?.message?.intermediateSteps || parsed.choices?.[0]?.message?.intermediate_steps) {
          const choiceSteps = parsed.choices[0].message.intermediateSteps || parsed.choices[0].message.intermediate_steps;
          if (Array.isArray(choiceSteps)) {
            logger.info(`Job ${jobId}: Processing ${choiceSteps.length} intermediate steps in message (final buffer)`);
            intermediateSteps = addIntermediateSteps(intermediateSteps, choiceSteps, jobId);
          }
        }

        const content =
          parsed.content ||
          parsed.choices?.[0]?.message?.content ||
          parsed.response ||
          parsed.text ||
          '';
        if (content) {
          fullText += content;
        }
      } catch (err) {
        // Treat as plain text if not JSON
        if (buffer.trim()) {
          fullText += buffer;
        }
      }
    }

    logger.info(`Job ${jobId}: Stream processing complete`, {
      fullTextLength: fullText.length,
      intermediateStepsCount: intermediateSteps.length,
      chunkCount,
      totalBytesReceived,
    });

    // Important: Do NOT mark as completed yet - we need to save all data first
    // This prevents the frontend from seeing "completed" while we're still writing data

    // Save the conversation to Redis if conversationId is provided
    if (jobRequest.conversationId) {
      try {
        // Process any base64 images in the response BEFORE saving
        let processedContent = fullText;
        try {
          const { processMarkdownImages } = await import('@/utils/app/imageHandler');
          processedContent = await processMarkdownImages(fullText);
          if (processedContent !== fullText) {
            logger.info(`Job ${jobId}: Replaced base64 images with Redis references`);
          }
        } catch (error) {
          logger.error(`Job ${jobId}: Failed to process images`, error);
          // Continue with original content if processing fails
        }

        // Extract image references from intermediate steps that may not be in the LLM response
        if (intermediateSteps?.length) {
          const imageRefPattern = /!\[[^\]]*\]\(\/api\/generated-image\/[a-f0-9-]+\)/g;
          const missingImageRefs: string[] = [];

          for (const step of intermediateSteps) {
            const candidates = [
              step?.payload?.data?.output,
              step?.payload?.data?.content,
              step?.payload?.data?.result,
              step?.payload?.metadata?.tool_outputs,
              step?.payload?.metadata?.chat_responses,
              step?.payload?.metadata?.original_payload?.payload,
              step?.payload?.metadata?.original_payload?.message,
              step?.payload?.metadata?.original_payload?.content,
            ];

            for (const candidate of candidates) {
              if (typeof candidate === 'string') {
                const matches = candidate.match(imageRefPattern);
                if (matches) {
                  for (const match of matches) {
                    if (!processedContent.includes(match) && !missingImageRefs.includes(match)) {
                      missingImageRefs.push(match);
                    }
                  }
                }
              }
            }
          }

          if (missingImageRefs.length > 0) {
            processedContent = processedContent + '\n\n' + missingImageRefs.join('\n\n');
            logger.info(`Job ${jobId}: Injected ${missingImageRefs.length} missing image reference(s) from intermediate steps`);
          }
        }

        // Build the complete conversation with the assistant's response
        const assistantMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: processedContent,  // Use processed content with image references
          intermediateSteps: intermediateSteps || [],
        };

        // Get all messages from the request and add the assistant response
        const allMessages = [...(jobRequest.messages || []), assistantMessage];

        // Save the complete conversation object to Redis
        const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
        const conversationData = {
          id: jobRequest.conversationId,
          name: jobRequest.conversationName,
          messages: allMessages,
          updatedAt: Date.now(),
          isPartial: false,  // Explicitly mark as final
          completedAt: Date.now(),
        };

        // Save the conversation with expiry (7 days to match other conversation saves)
        await jsonSetWithExpiry(conversationKey, conversationData, 60 * 60 * 24 * 7);

        // Also update the user's conversation history and selected conversation
        const userId = jobRequest.userId || 'anon';

        // Update selected conversation
        const selectedConvKey = sessionKey(['user', userId, 'selectedConversation']);
        const selectedConv = await jsonGet(selectedConvKey) as any;

        if (selectedConv && selectedConv.id === jobRequest.conversationId) {
          // Update the selected conversation with the new messages
          const updatedSelectedConv = {
            ...selectedConv,
            messages: allMessages,
            name: jobRequest.conversationName,
            updatedAt: Date.now(),
          };
          await jsonSetWithExpiry(selectedConvKey, updatedSelectedConv, 60 * 60 * 24 * 7);
          logger.info(`Job ${jobId}: Updated selected conversation for user ${userId}`);
        }

        logger.info(`Job ${jobId}: Saved COMPLETE conversation ${jobRequest.conversationId} to Redis with ${allMessages.length} messages`);

        // Clear streaming state and publish updates to other sessions
        await clearStreamingState(userId, jobRequest.conversationId);
        await publishStreamingState(userId, jobRequest.conversationId, false, jobId);
        await publishConversationUpdate(userId, conversationData);
        logger.info(`Job ${jobId}: Published streaming_ended and conversation_updated`);

        // Update job status with processed content (images replaced with references)
        await updateJobStatus(jobId, {
          status: 'completed',
          fullResponse: processedContent,  // Use processed content instead of raw fullText
          partialResponse: undefined, // Clear partial
          intermediateSteps,
          progress: 100,
          updatedAt: Date.now(),
          finalizedAt: Date.now(),  // Signal that ALL operations are complete
        });

        // Publish chat_complete to Redis for WS streaming
        if (jobRequest.conversationId) {
          const tokenChannel = `user:${jobRequest.userId}:chat:${jobRequest.conversationId}:tokens`;
          getPublisher().publish(tokenChannel, JSON.stringify({
            type: 'chat_complete',
            conversationId: jobRequest.conversationId,
            jobId,
            fullResponse: processedContent,
            intermediateSteps,
          })).catch(() => {});
        }
      } catch (error) {
        logger.error(`Job ${jobId}: Failed to save conversation to Redis`, error);
        // Clear streaming state even on error
        if (jobRequest.conversationId) {
          await clearStreamingState(userId, jobRequest.conversationId).catch(err => logger.error(`Job ${jobId}: failed to clear streaming state`, err));
          await publishStreamingState(userId, jobRequest.conversationId, false, jobId).catch(err => logger.error(`Job ${jobId}: failed to publish streaming state`, err));
        }
        // Still mark as completed even if save fails, using original content
        await updateJobStatus(jobId, {
          status: 'completed',
          fullResponse: fullText,  // Fallback to original content
          partialResponse: undefined,
          intermediateSteps,
          progress: 100,
          updatedAt: Date.now(),
          finalizedAt: Date.now(),
        });
      }
    } else {
      // No conversationId provided - just update job status with processed content
      let processedContent = fullText;
      try {
        const { processMarkdownImages } = await import('@/utils/app/imageHandler');
        processedContent = await processMarkdownImages(fullText);
        if (processedContent !== fullText) {
          logger.info(`Job ${jobId}: Replaced base64 images with Redis references (no conversation)`);
        }
      } catch (error) {
        logger.error(`Job ${jobId}: Failed to process images`, error);
      }

      // Extract image references from intermediate steps
      if (intermediateSteps?.length) {
        const imageRefPattern = /!\[[^\]]*\]\(\/api\/generated-image\/[a-f0-9-]+\)/g;
        const missingImageRefs: string[] = [];

        for (const step of intermediateSteps) {
          const candidates = [
            step?.payload?.data?.output,
            step?.payload?.data?.content,
            step?.payload?.data?.result,
            step?.payload?.metadata?.tool_outputs,
            step?.payload?.metadata?.original_payload?.payload,
            step?.payload?.metadata?.original_payload?.message,
            step?.payload?.metadata?.original_payload?.content,
          ];

          for (const candidate of candidates) {
            if (typeof candidate === 'string') {
              const matches = candidate.match(imageRefPattern);
              if (matches) {
                for (const match of matches) {
                  if (!processedContent.includes(match) && !missingImageRefs.includes(match)) {
                    missingImageRefs.push(match);
                  }
                }
              }
            }
          }
        }

        if (missingImageRefs.length > 0) {
          processedContent = processedContent + '\n\n' + missingImageRefs.join('\n\n');
          logger.info(`Job ${jobId}: Injected ${missingImageRefs.length} missing image reference(s) (no conversation)`);
        }
      }

      await updateJobStatus(jobId, {
        status: 'completed',
        fullResponse: processedContent,
        partialResponse: undefined,
        intermediateSteps,
        progress: 100,
        updatedAt: Date.now(),
        finalizedAt: Date.now(),
      });
    }

    logger.info(`Job ${jobId} completed successfully`);

    // Send push notification if no active WS connections for user
    try {
      const webpush = await import('web-push');
      const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
      if (vapidPublicKey && vapidPrivateKey && userId) {
        webpush.setVapidDetails('mailto:noreply@daedalus.app', vapidPublicKey, vapidPrivateKey);
        const subsKey = sessionKey(['user', userId, 'push-subscriptions']);
        const subscriptions = await jsonGet(subsKey);
        if (Array.isArray(subscriptions) && subscriptions.length > 0) {
          const payload = JSON.stringify({
            title: 'Response Ready',
            body: `Your conversation has a new response`,
            data: { conversationId: jobRequest.conversationId },
          });
          for (const sub of subscriptions) {
            webpush.sendNotification(sub, payload).catch((err: any) => {
              logger.warn(`Push notification failed for endpoint ${sub.endpoint}:`, err.statusCode);
            });
          }
        }
      }
    } catch (pushError) {
      logger.debug('Push notification skipped (not configured or failed)', pushError);
    }
  } catch (error) {
    logger.error(`Error processing async job ${jobId}`, error);

    // Try to clear streaming state on error
    try {
      const jobRequest = await jsonGet(sessionKey(['async-job-request', jobId])) as AsyncJobRequest | null;
      if (jobRequest?.conversationId && jobRequest?.userId) {
        await clearStreamingState(jobRequest.userId, jobRequest.conversationId);
        await publishStreamingState(jobRequest.userId, jobRequest.conversationId, false, jobId);
      }
    } catch (cleanupError) {
      logger.error(`Job ${jobId}: Failed to clear streaming state on error`, cleanupError);
    }

    await updateJobStatus(jobId, {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      updatedAt: Date.now(),
    });
  }
}

async function updateJobStatus(jobId: string, updates: Partial<AsyncJobStatus>): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

  if (!currentStatus) {
    logger.error('Job status not found for update', jobId);
    return;
  }

  const updatedStatus: AsyncJobStatus = {
    ...currentStatus,
    ...updates,
  };

  await jsonSetWithExpiry(statusKey, updatedStatus, JOB_EXPIRY_SECONDS);

  // Publish status update via Redis Pub/Sub for WebSocket sidecar
  try {
    const { getPublisher } = await import('../session/redis');
    const publisher = getPublisher();
    await publisher.publish(`job:${jobId}:status`, JSON.stringify(updatedStatus));
  } catch (err) {
    logger.error(`Failed to publish job status for ${jobId}`, err);
  }
}
