import { NextApiRequest, NextApiResponse } from 'next';
import { timingSafeEqual } from 'crypto';
import { trackUserUsage, UsageData } from '@/utils/usage/tracking';
import { getSession } from '@/utils/auth/session';

function isValidInternalToken(req: NextApiRequest): boolean {
  const expected =
    process.env.USAGE_TRACKING_INTERNAL_TOKEN || process.env.SESSION_SECRET;
  const provided = req.headers['x-daedalus-internal-token'];
  if (!expected || typeof provided !== 'string') return false;

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

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
    const session = await getSession(req, res);
    const internal = isValidInternalToken(req);

    if (!internal && !session?.username) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!internal && username !== session?.username) {
      return res.status(403).json({ error: 'Forbidden' });
    }

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
        received: {
          prompt_tokens: typeof prompt_tokens,
          completion_tokens: typeof completion_tokens,
          total_tokens: typeof total_tokens,
        }
      });
    }

    await trackUserUsage(username, usage as UsageData);

    return res.status(200).json({
      success: true,
    });
  } catch (error) {
    console.error('Usage tracking error:', error);
    return res.status(500).json({
      error: 'Internal server error while tracking usage',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
