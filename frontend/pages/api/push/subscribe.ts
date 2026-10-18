import type { NextApiRequest, NextApiResponse } from 'next';

import { updateJsonAtomically } from '@/server/atomicJson';
import {
  MAX_PUSH_SUBSCRIPTIONS,
  parsePushSubscription,
} from '@/server/pushSubscriptions';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { sessionKey } from '@/server/session/redis';

const PUSH_SUBSCRIPTION_EXPIRY = 60 * 60 * 24 * 30; // 30 days
class SubscriptionLimitError extends Error {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const userId = session.username;
  const key = sessionKey(['user', userId, 'push-subscriptions']);

  if (req.method === 'POST') {
    if (process.env.PUSH_NOTIFICATIONS_ENABLED === 'false')
      return res.status(503).json({ error: 'Push notifications are disabled' });
    const subscription = parsePushSubscription(req.body);
    if (!subscription) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }

    try {
      await updateJsonAtomically<unknown>(
        key,
        (existing) => {
          const subscriptions = Array.isArray(existing)
            ? existing
                .map(parsePushSubscription)
                .filter((item) => item !== null)
            : [];
          const filtered = subscriptions.filter(
            (s) => s.endpoint !== subscription.endpoint,
          );
          if (filtered.length >= MAX_PUSH_SUBSCRIPTIONS)
            throw new SubscriptionLimitError();
          return [...filtered, subscription];
        },
        PUSH_SUBSCRIPTION_EXPIRY,
      );
      return res.status(201).json({ success: true });
    } catch (error) {
      if (error instanceof SubscriptionLimitError)
        return res.status(409).json({ error: 'Too many push subscriptions' });
      console.error('Failed to store push subscription:', error);
      return res.status(500).json({ error: 'Failed to store subscription' });
    }
  }

  if (req.method === 'DELETE') {
    const { endpoint } = req.body || {};
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }

    try {
      await updateJsonAtomically<unknown>(
        key,
        (existing) => {
          const subscriptions = Array.isArray(existing) ? existing : [];
          return subscriptions.filter((s) => s?.endpoint !== endpoint);
        },
        PUSH_SUBSCRIPTION_EXPIRY,
      );
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Failed to remove push subscription:', error);
      return res.status(500).json({ error: 'Failed to remove subscription' });
    }
  }

  res.setHeader('Allow', ['POST', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
