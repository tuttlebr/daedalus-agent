import { NextApiRequest, NextApiResponse } from 'next';

import { getSession } from '@/utils/auth/session';
import { getAllUsageStats } from '@/utils/usage/tracking';

import { getRedis } from '@/server/session/redis';

/**
 * Debug endpoint to check usage tracking status
 * GET /api/usage/debug
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getSession(req, res);
    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    if (session?.username !== adminUsername) {
      return res.status(session ? 403 : 401).json({
        error: session
          ? 'Forbidden: Admin access required'
          : 'Not authenticated',
      });
    }

    const redis = getRedis();

    // Get all keys matching usage pattern via SCAN — KEYS is O(N) and blocks
    // the Redis event loop on large keyspaces (F-018).
    const usageKeys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        'usage:user:*',
        'COUNT',
        100,
      );
      cursor = next;
      usageKeys.push(...batch);
    } while (cursor !== '0');

    // Get all usage stats
    const allStats = await getAllUsageStats();

    // Get sample data from first key if exists
    let sampleData = null;
    if (usageKeys.length > 0) {
      const firstKey = usageKeys[0];
      sampleData = (await redis.call('JSON.GET', firstKey)) as string;
    }

    return res.status(200).json({
      success: true,
      debug: {
        totalUsageKeys: usageKeys.length,
        usageKeys: usageKeys,
        statsCount: allStats.length,
        allStats: allStats,
        sampleKey: usageKeys[0] || null,
        sampleData: sampleData ? JSON.parse(sampleData) : null,
      },
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
}
