import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry, jsonDel } from '../session/redis';
import { v4 as uuidv4 } from 'uuid';

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
}

const JOB_EXPIRY_SECONDS = 60 * 60; // 1 hour

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const redis = getRedis();

  if (req.method === 'POST') {
    // Create new async job
    try {
      const { messages, chatCompletionURL, additionalProps, userId } = req.body;

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
      };

      const requestKey = sessionKey(['async-job-request', jobId]);
      await jsonSetWithExpiry(requestKey, jobRequest, JOB_EXPIRY_SECONDS);

      // Initialize job status
      const jobStatus: AsyncJobStatus = {
        jobId,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
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

    // Determine backend URL - must match the logic from /api/chat.ts for Kubernetes
    const useDeepThinker = additionalProps?.useDeepThinker || false;
    const baseBackendHost = process.env.BACKEND_HOST || 'daedalus-backend';
    const backendSuffix = useDeepThinker ? '-deep-thinker' : '-default';
    const backendHost = baseBackendHost + backendSuffix + '.daedalus.svc.cluster.local';
    const endpoint = `http://${backendHost}:8000/chat`;

    // Construct payload matching the regular chat endpoint format
    const payload = {
      messages,
      model: 'string',
      temperature: 0,
      max_tokens: 0,
      top_p: 0,
      use_knowledge_base: true,
      top_k: 0,
      collection_name: 'string',
      stop: true,
      additionalProp1: {},
      stream_options: {
        include_usage: true,
      },
    };

    // Make request to backend
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': additionalProps?.username || 'anon',
        'X-Backend-Type': useDeepThinker ? 'deep-thinker' : 'default',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
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

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // Decode chunk and add to buffer
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim(); // Remove "data: " prefix
            
            if (data === '[DONE]') {
              console.log(`Async job ${jobId}: Streaming complete`);
              break;
            }

            try {
              const parsed = JSON.parse(data);
              
              // Extract content from OpenAI-compatible response
              const content = 
                parsed.choices?.[0]?.message?.content ||
                parsed.choices?.[0]?.delta?.content ||
                '';

              if (content) {
                fullText += content;
                chunkCount++;

                // Update status every 10 chunks
                if (chunkCount % 10 === 0) {
                  await updateJobStatus(jobId, {
                    status: 'streaming',
                    partialResponse: fullText,
                    intermediateSteps,
                    progress: Math.min(90, chunkCount * 2),
                    updatedAt: Date.now(),
                  });
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
                const payload = JSON.parse(data);
                
                // Transform to intermediate step format
                const intermediateStep = {
                  parent_id: payload?.parent_id || 'root',
                  function_ancestry: {
                    node_id: payload?.id || `step-${Date.now()}`,
                    parent_id: payload?.parent_id || null,
                    function_name: payload?.name || 'Unknown',
                    depth: 0
                  },
                  payload: {
                    event_type: payload?.status === 'completed' ? 'CUSTOM_END' : 'CUSTOM_START',
                    event_timestamp: payload?.time_stamp || Date.now() / 1000,
                    name: payload?.name || 'Step',
                    metadata: {
                      original_payload: payload
                    },
                    data: {
                      output: payload?.payload || 'No details'
                    },
                  }
                };
                
                intermediateSteps.push(intermediateStep);
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

    // Mark as completed
    await updateJobStatus(jobId, {
      status: 'completed',
      fullResponse: fullText,
      partialResponse: undefined, // Clear partial
      intermediateSteps,
      progress: 100,
      updatedAt: Date.now(),
    });

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
