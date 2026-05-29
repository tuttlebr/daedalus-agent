import type { NextApiRequest, NextApiResponse } from 'next';

import { AutonomyGoal } from '@/types/autonomy';

import {
  createGoal,
  listGoals,
  nowMs,
  saveGoals,
} from '@/server/autonomy/store';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  const userId = session.username;

  if (req.method === 'GET') {
    return res.status(200).json(await listGoals(userId));
  }

  if (req.method === 'POST') {
    const goal = await createGoal(userId, req.body || {});
    return res.status(201).json(goal);
  }

  if (req.method === 'PATCH') {
    const { id, ...updates } = req.body || {};
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required' });
    }
    // Whitelist updatable fields and validate them — never spread arbitrary
    // client keys into the persisted goal (F-009).
    const sanitized: Partial<AutonomyGoal> = {};
    if (typeof updates.title === 'string') {
      sanitized.title = updates.title.trim() || 'Untitled goal';
    }
    if (typeof updates.description === 'string') {
      sanitized.description = updates.description.trim();
    }
    if (['active', 'paused', 'completed'].includes(updates.status)) {
      sanitized.status = updates.status;
    }
    if (Number.isFinite(updates.priority)) {
      sanitized.priority = Number(updates.priority);
    }
    const goals = await listGoals(userId);
    const next = goals.map(
      (goal): AutonomyGoal =>
        goal.id === id
          ? { ...goal, ...sanitized, id: goal.id, updatedAt: nowMs() }
          : goal,
    );
    await saveGoals(userId, next);
    return res.status(200).json(next.find((goal) => goal.id === id) || null);
  }

  if (req.method === 'DELETE') {
    const id = typeof req.query.id === 'string' ? req.query.id : req.body?.id;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'id is required' });
    }
    await saveGoals(
      userId,
      (await listGoals(userId)).filter((goal) => goal.id !== id),
    );
    return res.status(204).end();
  }

  res.setHeader('Allow', ['GET', 'POST', 'PATCH', 'DELETE']);
  return res.status(405).end('Method Not Allowed');
}
