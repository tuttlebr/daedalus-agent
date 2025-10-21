import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSet, jsonSetWithExpiry, jsonDel } from '../session/redis';
import { v4 as uuidv4 } from 'uuid';
import { Message } from '@/types/chat';
import { IntermediateStepType } from '@/types/intermediateSteps';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb',
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
}

const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const redis = getRedis();

  if (req.method === 'POST') {
    // Create new async job
    try {
      const { messages, chatCompletionURL, additionalProps, userId, conversationId } = req.body;

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
        console.error('Error in async job processing:', err);
      });

      return res.status(200).json({ jobId, status: 'pending' });
    } catch (error) {
      console.error('Error creating async job:', error);
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
      console.error('Error fetching job status:', error);
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
      console.error('Error canceling job:', error);
      return res.status(500).json({ error: 'Failed to cancel job' });
    }
  }

  res.setHeader('Allow', ['POST', 'GET', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
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

    const { messages, chatCompletionURL, additionalProps } = jobRequest;

    // Add system context message for username (matching regular chat endpoint)
    const systemMessages: Message[] = [];
    // if (additionalProps?.username) {
    //   systemMessages.push({
    //     role: 'system',
    //     content: `The authenticated user's username is "${additionalProps.username}".`
    //   });
    // }

    // Combine system messages with user messages
    const messagesWithContext = [...systemMessages, ...(messages || [])];

    // Determine backend URL - must match the logic from /api/chat.ts
    const useDeepThinker = additionalProps?.useDeepThinker || false;

    // Check if we're in Kubernetes or Docker Compose environment
    const isKubernetes = process.env.KUBERNETES_SERVICE_HOST || process.env.DEPLOYMENT_MODE === 'kubernetes';

    let endpoint: string;
    if (isKubernetes) {
      const baseBackendHost = process.env.BACKEND_HOST || 'daedalus-backend';
      const backendSuffix = useDeepThinker ? '-deep-thinker' : '-default';
      const backendHost = baseBackendHost + backendSuffix + '.daedalus.svc.cluster.local';
      endpoint = `http://${backendHost}:8000/chat/stream`;
    } else {
      // Docker Compose or local development
      const backendHost = process.env.BACKEND_HOST || 'backend';
      const backendPort = process.env.BACKEND_PORT || '8000';
      endpoint = `http://${backendHost}:${backendPort}/chat/stream`;
    }

    console.log(`Async job ${jobId}: Using backend endpoint: ${endpoint}`);

    // Construct payload matching the regular chat endpoint format
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
      stream: true,  // Explicitly request streaming response
      enable_intermediate_steps: additionalProps?.enableIntermediateSteps ?? true,  // Enable intermediate steps
      additionalProp1: {},
      stream_options: {
        include_usage: true,
      },
    };

    // Make request to backend
    console.log(`Async job ${jobId}: Sending request with payload:`, {
      messageCount: messagesWithContext?.length,
      originalMessageCount: messages?.length,
      hasSystemMessage: systemMessages.length > 0,
      stream: payload.stream,
      enable_intermediate_steps: payload.enable_intermediate_steps,
      useDeepThinker,
      additionalProps,
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',  // Expect SSE response
        'x-user-id': additionalProps?.username || 'anon',
        'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(payload),
    });

    console.log(`Async job ${jobId}: Received response:`, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Async job ${jobId}: Backend error:`, errorText);
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

    console.log(`Async job ${jobId}: Starting to read response stream...`);

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          console.log(`Async job ${jobId}: Stream reading completed. Total bytes: ${totalBytesReceived}`);
          break;
        }

        totalBytesReceived += value?.length || 0;

        // Decode chunk and add to buffer
        const chunkText = decoder.decode(value, { stream: true });
        buffer += chunkText;

        // Log first chunk for debugging
        if (chunkCount === 0 && chunkText) {
          console.log(`Async job ${jobId}: First chunk preview:`, chunkText.substring(0, 200));
          // Check if it's SSE format
          if (chunkText.includes('data: ')) {
            console.log(`Async job ${jobId}: ✅ Detected SSE format`);
          } else {
            console.log(`Async job ${jobId}: ⚠️ Not SSE format - appears to be JSON`);
          }
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue; // Skip empty lines

          // Debug: Log all lines to see what we're receiving
          if (intermediateSteps.length === 0 && line.trim()) {
            console.log(`Async job ${jobId}: Line received:`, line.substring(0, 150));
          }

          // Specifically check for intermediate_data lines
          if (line.includes('intermediate_data:') || line.includes('intermediate_step') || line.includes('intermediateStep')) {
            console.log(`Async job ${jobId}: Found potential intermediate step line:`, line);
          }

          // Log non-SSE formatted lines for debugging
          if (!line.startsWith('data: ') && !line.startsWith('intermediate_data: ')) {
            console.log(`Async job ${jobId}: Non-SSE line detected:`, line.substring(0, 100));

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
                console.log(`Async job ${jobId}: Found content in non-SSE format`);
                fullText += content;
                chunkCount++;
              }

            // Check for intermediate steps in non-SSE format
            if (parsed.intermediate_steps || parsed.intermediateSteps) {
              const steps = parsed.intermediate_steps || parsed.intermediateSteps;
              if (Array.isArray(steps)) {
                console.log(`Async job ${jobId}: Found ${steps.length} intermediate steps in non-SSE format`);
                intermediateSteps.push(...steps);
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
                    intermediateSteps.push(step);
                    console.log(`Async job ${jobId}: Found intermediate step in tag format`);
                  }
                } catch (err) {
                  console.error(`Async job ${jobId}: Failed to parse intermediate step:`, err);
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
                console.log(`Async job ${jobId}: Treating as plain text response`);
                fullText += line + '\n';
                chunkCount++;
              }
            }
            continue;
          }

          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim(); // Remove "data: " prefix

            if (data === '[DONE]') {
              console.log(`Async job ${jobId}: SSE streaming complete signal received`);
              break;
            }

            try {
              const parsed = JSON.parse(data);

              // Check if this data chunk contains intermediate steps
              if (parsed.intermediate_steps || parsed.intermediateSteps) {
                console.log(`Async job ${jobId}: Found intermediate steps in data: event`, parsed.intermediate_steps || parsed.intermediateSteps);
                const steps = parsed.intermediate_steps || parsed.intermediateSteps;
                if (Array.isArray(steps)) {
                  console.log(`Async job ${jobId}: Adding ${steps.length} intermediate steps from data chunk`);
                  intermediateSteps.push(...steps);
                }
              }

              // Check for intermediate steps in the choices object
              if (parsed.choices?.[0]?.message?.intermediateSteps || parsed.choices?.[0]?.message?.intermediate_steps) {
                const choiceSteps = parsed.choices[0].message.intermediateSteps || parsed.choices[0].message.intermediate_steps;
                if (Array.isArray(choiceSteps)) {
                  console.log(`Async job ${jobId}: Found ${choiceSteps.length} intermediate steps in message`);
                  intermediateSteps.push(...choiceSteps);
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
                        intermediateSteps.push(step);
                        console.log(`Async job ${jobId}: Found intermediate step in SSE content`);
                      }
                    } catch (err) {
                      console.error(`Async job ${jobId}: Failed to parse intermediate step from SSE:`, err);
                    }
                  }
                  // Remove intermediate step tags from content
                  content = content.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');
                }

                fullText += content;
                chunkCount++;

                // Update status every 5 chunks for more responsive UI
                if (chunkCount % 5 === 0) {
                  await updateJobStatus(jobId, {
                    status: 'streaming',
                    partialResponse: fullText,
                    intermediateSteps,
                    progress: Math.min(90, chunkCount * 2),
                    updatedAt: Date.now(),
                  });

                  // Also save partial conversation to Redis for recovery
                  if (jobRequest.conversationId) {
                    try {
                      const partialMessage: Message = {
                        role: 'assistant',
                        content: fullText,
                        intermediateSteps: intermediateSteps || [],
                      };
                      const partialConversation = {
                        id: jobRequest.conversationId,
                        messages: [...(jobRequest.messages || []), partialMessage],
                        updatedAt: Date.now(),
                        isPartial: true,
                      };
                      const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
                      await jsonSet(conversationKey, '$', partialConversation);
                    } catch (err) {
                      console.error(`Failed to save partial conversation:`, err);
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`Async job ${jobId}: Error parsing JSON chunk:`, err);
            }
          } else if (line.startsWith('intermediate_data: ')) {
            // Handle intermediate steps
            const data = line.slice(19).trim(); // Remove "intermediate_data: " prefix

            if (data !== '[DONE]') {
              try {
                console.log(`Async job ${jobId}: Received intermediate_data:`, data.substring(0, 200));
                const payload = JSON.parse(data);

                // Check if it's already in the correct format
                let intermediateStep;
                if (payload?.payload?.event_type) {
                  intermediateStep = payload;
                  console.log(`Async job ${jobId}: Intermediate step already formatted:`, payload.payload.name || payload.payload.event_type);
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
                  console.log(`Async job ${jobId}: Transformed intermediate step:`, intermediateStep.payload.name);
                }

                intermediateSteps.push(intermediateStep);

                // Immediately update status when intermediate step arrives for instant UI feedback
                console.log(`Async job ${jobId}: Total intermediate steps: ${intermediateSteps.length}`);
                await updateJobStatus(jobId, {
                  status: 'streaming',
                  partialResponse: fullText,
                  intermediateSteps: [...intermediateSteps], // Clone array for reactivity
                  progress: Math.min(90, chunkCount * 2),
                  updatedAt: Date.now(),
                });

                // Save conversation with intermediate steps
                if (jobRequest.conversationId) {
                  try {
                    const intermediateMessage: Message = {
                      role: 'assistant',
                      content: fullText || '',
                      intermediateSteps: [...intermediateSteps],
                    };
                    const intermediateConversation = {
                      id: jobRequest.conversationId,
                      messages: [...(jobRequest.messages || []), intermediateMessage],
                      updatedAt: Date.now(),
                      isPartial: true,
                    };
                    const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
                    await jsonSet(conversationKey, '$', intermediateConversation);
                    console.log(`Saved intermediate conversation state with ${intermediateSteps.length} steps`);
                  } catch (err) {
                    console.error(`Failed to save intermediate conversation:`, err);
                  }
                }
              } catch (err) {
                console.error(`Async job ${jobId}: Error parsing intermediate step:`, err);
              }
            }
          }
        }
      }
    } catch (readError) {
      console.error(`Async job ${jobId}: Error reading stream:`, readError);
      throw readError;
    }

    // Process any remaining data in buffer
    if (buffer.trim()) {
      console.log(`Async job ${jobId}: Processing remaining buffer:`, buffer.substring(0, 100));
      try {
        const parsed = JSON.parse(buffer);

        // Debug: Log the structure of the response
        console.log(`Async job ${jobId}: Complete response structure:`, {
          hasChoices: !!parsed.choices,
          hasIntermediateSteps: !!(parsed.intermediate_steps || parsed.intermediateSteps),
          messageKeys: parsed.choices?.[0]?.message ? Object.keys(parsed.choices[0].message) : [],
          topLevelKeys: Object.keys(parsed).slice(0, 10)
        });

        // Check for intermediate steps at various levels
        if (parsed.intermediate_steps || parsed.intermediateSteps) {
          const steps = parsed.intermediate_steps || parsed.intermediateSteps;
          if (Array.isArray(steps)) {
            console.log(`Async job ${jobId}: Found ${steps.length} intermediate steps in final buffer`);
            intermediateSteps.push(...steps);
          }
        }

        if (parsed.choices?.[0]?.message?.intermediateSteps || parsed.choices?.[0]?.message?.intermediate_steps) {
          const choiceSteps = parsed.choices[0].message.intermediateSteps || parsed.choices[0].message.intermediate_steps;
          if (Array.isArray(choiceSteps)) {
            console.log(`Async job ${jobId}: Found ${choiceSteps.length} intermediate steps in message (final buffer)`);
            intermediateSteps.push(...choiceSteps);
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

    console.log(`Async job ${jobId}: Stream processing complete. Final stats:`, {
      fullTextLength: fullText.length,
      fullTextPreview: fullText.substring(0, 100),
      intermediateStepsCount: intermediateSteps.length,
      chunkCount,
      totalBytesReceived,
    });

    // Mark as completed
    await updateJobStatus(jobId, {
      status: 'completed',
      fullResponse: fullText,
      partialResponse: undefined, // Clear partial
      intermediateSteps,
      progress: 100,
      updatedAt: Date.now(),
    });

    // Save the conversation to Redis if conversationId is provided
    if (jobRequest.conversationId) {
      try {
        // Build the complete conversation with the assistant's response
        const assistantMessage: Message = {
          id: uuidv4(),
          role: 'assistant',
          content: fullText,
          intermediateSteps: intermediateSteps || [],
        };

        // Get all messages from the request and add the assistant response
        const allMessages = [...(jobRequest.messages || []), assistantMessage];

        // Save the complete conversation object to Redis
        const conversationKey = sessionKey(['conversation', jobRequest.conversationId]);
        const conversationData = {
          id: jobRequest.conversationId,
          messages: allMessages,
          updatedAt: Date.now(),
          isPartial: false,
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
            updatedAt: Date.now(),
          };
          await jsonSetWithExpiry(selectedConvKey, updatedSelectedConv, 60 * 60 * 24 * 7);
          console.log(`Async job ${jobId}: Updated selected conversation for user ${userId}`);
        }

        // Update conversation history
        const historyKey = sessionKey(['user', userId, 'conversationHistory']);
        const history = await jsonGet(historyKey) || [];

        // Find and update the conversation in history
        let found = false;
        const updatedHistory = history.map((conv: any) => {
          if (conv.id === jobRequest.conversationId) {
            found = true;
            return {
              ...conv,
              messages: allMessages,
              updatedAt: Date.now(),
            };
          }
          return conv;
        });

        // If not found in history, add it (shouldn't happen but just in case)
        if (!found && selectedConv) {
          updatedHistory.push({
            ...selectedConv,
            messages: allMessages,
          });
        }

        if (found || selectedConv) {
          await jsonSetWithExpiry(historyKey, updatedHistory, 60 * 60 * 24 * 7);
          console.log(`Async job ${jobId}: Updated conversation history for user ${userId}, found=${found}, historyLength=${updatedHistory.length}`);
        }

        console.log(`Async job ${jobId}: Saved COMPLETE conversation ${jobRequest.conversationId} to Redis with ${allMessages.length} messages`);
      } catch (error) {
        console.error(`Async job ${jobId}: Failed to save conversation to Redis:`, error);
      }
    }

    console.log(`Async job ${jobId} completed successfully`);
  } catch (error: any) {
    console.error(`Error processing async job ${jobId}:`, error);

    await updateJobStatus(jobId, {
      status: 'error',
      error: error.message || 'Unknown error',
      updatedAt: Date.now(),
    });
  }
}

async function updateJobStatus(jobId: string, updates: Partial<AsyncJobStatus>): Promise<void> {
  const statusKey = sessionKey(['async-job-status', jobId]);
  const currentStatus = await jsonGet(statusKey) as AsyncJobStatus | null;

  if (!currentStatus) {
    console.error('Job status not found for update:', jobId);
    return;
  }

  const updatedStatus: AsyncJobStatus = {
    ...currentStatus,
    ...updates,
  };

  await jsonSetWithExpiry(statusKey, updatedStatus, JOB_EXPIRY_SECONDS);
}
