import { NextApiRequest, NextApiResponse } from 'next';
import { trackUserUsage, UsageData } from '@/utils/usage/tracking';

/**
 * API endpoint to track user usage
 * POST /api/usage/track
 * Body: { username: string, usage: UsageData }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, usage } = req.body;

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Username is required and must be a string' });
    }

    if (!usage || typeof usage !== 'object') {
      return res.status(400).json({ error: 'Usage data is required and must be an object' });
    }

    // Validate usage data structure
    const { prompt_tokens, completion_tokens, total_tokens } = usage as UsageData;

    if (
      typeof prompt_tokens !== 'number' ||
      typeof completion_tokens !== 'number' ||
      typeof total_tokens !== 'number'
    ) {
      return res.status(400).json({
        error: 'Usage data must contain numeric values for prompt_tokens, completion_tokens, and total_tokens',
      });
    }

    // Track the usage
    await trackUserUsage(username, usage as UsageData);

    return res.status(200).json({
      success: true,
      message: 'Usage tracked successfully',
    });
  } catch (error) {
    console.error('Error tracking usage:', error);
    return res.status(500).json({
      error: 'Internal server error while tracking usage',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
