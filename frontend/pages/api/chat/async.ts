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

    // Determine backend URL
    const backendHost = process.env.BACKEND_HOST || 'http://backend:8000';
    const useDeepThinker = additionalProps?.useDeepThinker || false;
    const endpoint = useDeepThinker 
      ? `${backendHost}/chat_completions_deep_thinker`
      : `${backendHost}/chat_completions`;

    // Make request to backend
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        stream: true,
        stream_options: {
          include_usage: true,
        },
        enable_intermediate_steps: additionalProps?.enableIntermediateSteps || false,
      }),
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
    let done = false;
    let chunkCount = 0;

    while (!done) {
      const { value, done: doneReading } = await reader.read();
      done = doneReading;

      if (value) {
        let chunkValue = decoder.decode(value);
        chunkCount++;

        // Extract intermediate steps
        const stepMatches = chunkValue.match(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g) || [];
        for (const match of stepMatches) {
          try {
            const jsonString = match.replace('<intermediatestep>', '').replace('</intermediatestep>', '').trim();
            const step = JSON.parse(jsonString);
            intermediateSteps.push(step);
          } catch (err) {
            console.error('Failed to parse intermediate step:', err);
          }
        }

        // Remove intermediate step tags from text
        chunkValue = chunkValue.replace(/<intermediatestep>[\s\S]*?<\/intermediatestep>/g, '');
        fullText += chunkValue;

        // Update status every 10 chunks
        if (chunkCount % 10 === 0) {
          await updateJobStatus(jobId, {
            status: 'streaming',
            partialResponse: fullText,
            intermediateSteps,
            progress: Math.min(90, chunkCount * 2), // Estimate progress
            updatedAt: Date.now(),
          });
        }
      }
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
