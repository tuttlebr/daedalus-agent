import { NextApiRequest, NextApiResponse } from 'next';
import { getUserUsageStats, getAllUsageStats } from '@/utils/usage/tracking';
import { getSession } from '@/utils/auth/session';

/**
 * API endpoint to retrieve user usage statistics
 * GET /api/usage/stats?username=<username>
 * GET /api/usage/stats (returns current user's stats)
 * GET /api/usage/stats?all=true (admin only - returns all users' stats)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify session
    const session = await getSession(req, res);

    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { username, all } = req.query;

    // If requesting all users' stats (admin function)
    if (all === 'true') {
      // TODO: Add admin check here if you have role-based access control
      const allStats = await getAllUsageStats();
      return res.status(200).json({
        success: true,
        data: allStats,
      });
    }

    // Get stats for specific user or current user
    const targetUsername = (username as string) || session.username;

    // Security: Users can only see their own stats unless they're admin
    // TODO: Add admin check here if you want to allow admins to see other users' stats
    if (targetUsername !== session.username) {
      return res.status(403).json({
        error: 'Forbidden: You can only view your own usage statistics',
      });
    }

    const stats = await getUserUsageStats(targetUsername);

    if (!stats) {
      return res.status(404).json({
        error: 'No usage statistics found for this user',
      });
    }

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error('Error retrieving usage stats:', error);
    return res.status(500).json({
      error: 'Internal server error while retrieving usage statistics',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
