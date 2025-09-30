import { NextApiRequest, NextApiResponse } from 'next';
import { getUserUsageStats, getAllUsageStats } from '@/utils/usage/tracking';
import { getRedis } from '@/pages/api/session/redis';

/**
 * Debug endpoint to check usage tracking status
 * GET /api/usage/debug
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const redis = getRedis();

    // Get all keys matching usage pattern
    const usageKeys = await redis.keys('usage:user:*');

    // Get all usage stats
    const allStats = await getAllUsageStats();

    // Get sample data from first key if exists
    let sampleData = null;
    if (usageKeys.length > 0) {
      const firstKey = usageKeys[0];
      sampleData = await redis.call('JSON.GET', firstKey) as string;
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
      }
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
