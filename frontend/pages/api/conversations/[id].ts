import type { NextApiRequest, NextApiResponse } from 'next';
import { getRedis, sessionKey, jsonGet, jsonSetWithExpiry } from '../session/redis';

/**
 * Simple endpoint: Get latest conversation state including any async job results.
 * This allows the frontend to fetch completed responses after returning from background.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'PUT') {
    const { id } = req.query;
    const { messages, updatedAt } = req.body;

    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Invalid conversation ID' });
    }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    try {
      const redis = getRedis();
      const conversationKey = sessionKey(['conversation', id]);

      // Save the conversation state (expire after 7 days)
      await jsonSetWithExpiry(conversationKey, {
        messages,
        updatedAt: updatedAt || Date.now(),
      }, 60 * 60 * 24 * 7);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error saving conversation:', error);
      return res.status(500).json({ error: 'Failed to save conversation' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid conversation ID' });
  }

  try {
    const redis = getRedis();

    // First check for saved conversation data
    const conversationKey = sessionKey(['conversation', id]);
    const conversationData = await jsonGet(conversationKey);

    if (conversationData && conversationData.messages) {
      // Return the saved conversation messages
      return res.status(200).json({
        conversationId: id,
        messages: conversationData.messages,
        status: 'completed',
        updatedAt: conversationData.updatedAt,
      });
    }

    // Check for any pending/completed async jobs for this conversation
    const jobKey = sessionKey(['conversation-job', id]);
    const jobData = await jsonGet(jobKey);

    if (jobData && typeof jobData === 'object' && 'messages' in jobData) {
      // Return the full conversation state from the job
      return res.status(200).json({
        conversationId: id,
        messages: jobData.messages,
        status: (jobData as any).status || 'completed',
      });
    }

    // No conversation found, return empty state
    return res.status(200).json({
      conversationId: id,
      messages: [],
      status: 'idle',
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    return res.status(500).json({ error: 'Failed to fetch conversation' });
  }
}
