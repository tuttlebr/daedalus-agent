import type { NextApiRequest, NextApiResponse } from 'next';
import { getSubscriber, channels, getStreamingStates } from '../session/redis';
import { getSession } from '@/utils/auth/session';
import { SyncEvent } from '@/utils/sync/publish';
import Redis from 'ioredis';

export const config = {
  api: {
    bodyParser: false,
  },
};

const HEARTBEAT_INTERVAL = 30000; // 30 seconds

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate session
  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const userId = session.username;
  if (!userId) {
    return res.status(400).json({ error: 'Invalid user' });
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Flush headers
  res.flushHeaders();

  // Send initial connection event with current streaming states
  const currentStreamingStates = await getStreamingStates(userId);
  sendSSEEvent(res, 'connected', {
    userId,
    timestamp: Date.now(),
    streamingStates: currentStreamingStates,
  });

  // Create dedicated subscriber for this connection
  let subscriber: Redis | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let isCleanedUp = false;

  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    if (subscriber) {
      const channel = channels.userUpdates(userId);
      subscriber.unsubscribe(channel).catch(err => console.error('SSE subscriber unsubscribe error:', err));
      subscriber.quit().catch(err => console.error('SSE subscriber quit error:', err));
      subscriber = null;
    }

    console.log(`SSE sync connection closed for user ${userId}`);
  };

  try {
    // Get a new subscriber instance for this connection
    subscriber = getSubscriber().duplicate();

    await subscriber.connect();

    const channel = channels.userUpdates(userId);

    // Handle incoming messages
    subscriber.on('message', (receivedChannel: string, message: string) => {
      if (receivedChannel === channel && !isCleanedUp) {
        try {
          const event: SyncEvent = JSON.parse(message);
          sendSSEEvent(res, event.type, event.data);
        } catch (error) {
          console.error('Error parsing sync message:', error);
        }
      }
    });

    // Subscribe to user's update channel
    await subscriber.subscribe(channel);
    console.log(`SSE sync connection established for user ${userId}`);

    // Start heartbeat
    heartbeatTimer = setInterval(() => {
      if (!isCleanedUp) {
        sendSSEEvent(res, 'heartbeat', { timestamp: Date.now() });
      }
    }, HEARTBEAT_INTERVAL);

    // Handle client disconnect
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);

  } catch (error) {
    console.error('Error setting up SSE sync:', error);
    cleanup();
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to establish sync connection' });
    }
  }
}

function sendSSEEvent(res: NextApiResponse, eventType: string, data: any): void {
  try {
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // @ts-ignore - flush exists on ServerResponse
    if (res.flush) res.flush();
  } catch {
    // Expected when client disconnects - no action needed
  }
}
