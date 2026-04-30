import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionKey, jsonSetWithExpiry, jsonDel, jsonGet } from '../session/redis';
import { requireAuthenticatedUser } from '../session/_utils';

const PUSH_SUBSCRIPTION_EXPIRY = 60 * 60 * 24 * 30; // 30 days

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  const userId = session.username;
  const key = sessionKey(['user', userId, 'push-subscriptions']);

  if (req.method === 'POST') {
    const subscription = req.body;
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: 'Invalid push subscription' });
    }

    try {
      // Store as a list of subscriptions (user may have multiple devices)
      const existing = (await jsonGet(key)) || [];
      const subscriptions = Array.isArray(existing) ? existing : [];

      // Replace if same endpoint exists, otherwise add
      const filtered = subscriptions.filter((s: any) => s.endpoint !== subscription.endpoint);
      filtered.push(subscription);

      await jsonSetWithExpiry(key, filtered, PUSH_SUBSCRIPTION_EXPIRY);
      return res.status(201).json({ success: true });
    } catch (error) {
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
      const existing = (await jsonGet(key)) || [];
      const subscriptions = Array.isArray(existing) ? existing : [];
      const filtered = subscriptions.filter((s: any) => s.endpoint !== endpoint);
      if (filtered.length > 0) {
        await jsonSetWithExpiry(key, filtered, PUSH_SUBSCRIPTION_EXPIRY);
      } else {
        await jsonDel(key);
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Failed to remove push subscription:', error);
      return res.status(500).json({ error: 'Failed to remove subscription' });
    }
  }

  res.setHeader('Allow', ['POST', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
