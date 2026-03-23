import { NextApiRequest, NextApiResponse } from 'next';
import { trackUserUsage, UsageData } from '@/utils/usage/tracking';

/**
 * API endpoint to track user usage
 * POST /api/usage/track
 * Body: { username: string, usage: UsageData }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  console.log('daedalus - /api/usage/track called');

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { username, usage } = req.body;

    console.log('daedalus - /api/usage/track received:', {
      username,
      usage,
      bodyKeys: Object.keys(req.body || {})
    });

    if (!username || typeof username !== 'string') {
      console.error('daedalus - /api/usage/track: invalid username:', username);
      return res.status(400).json({ error: 'Username is required and must be a string' });
    }

    if (!usage || typeof usage !== 'object') {
      console.error('daedalus - /api/usage/track: invalid usage object:', usage);
      return res.status(400).json({ error: 'Usage data is required and must be an object' });
    }

    // Validate usage data structure
    const { prompt_tokens, completion_tokens, total_tokens } = usage as UsageData;

    console.log('daedalus - /api/usage/track: parsed usage fields:', {
      prompt_tokens,
      completion_tokens,
      total_tokens,
      types: {
        prompt_tokens: typeof prompt_tokens,
        completion_tokens: typeof completion_tokens,
        total_tokens: typeof total_tokens
      }
    });

    if (
      typeof prompt_tokens !== 'number' ||
      typeof completion_tokens !== 'number' ||
      typeof total_tokens !== 'number'
    ) {
      console.error('daedalus - /api/usage/track: non-numeric values detected');
      return res.status(400).json({
        error: 'Usage data must contain numeric values for prompt_tokens, completion_tokens, and total_tokens',
        received: {
          prompt_tokens: typeof prompt_tokens,
          completion_tokens: typeof completion_tokens,
          total_tokens: typeof total_tokens,
        }
      });
    }

    console.log('daedalus - /api/usage/track: calling trackUserUsage for', username);

    // Track the usage
    await trackUserUsage(username, usage as UsageData);

    console.log('daedalus - /api/usage/track: successfully tracked usage for', username);

    return res.status(200).json({
      success: true,
      message: 'Usage tracked successfully',
      tracked: {
        username,
        prompt_tokens,
        completion_tokens,
        total_tokens
      }
    });
  } catch (error) {
    console.error('daedalus - /api/usage/track error:', error);
    return res.status(500).json({
      error: 'Internal server error while tracking usage',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
