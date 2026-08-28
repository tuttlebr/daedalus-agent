import type { NextApiRequest, NextApiResponse } from 'next';

import {
  GOOGLE_WORKSPACE_SERVICES,
  type GoogleWorkspaceServiceId,
} from '@/utils/app/googleWorkspace';

import {
  getGoogleWorkspaceConnections,
  resetGoogleWorkspaceConnection,
} from '@/server/googleWorkspaceConnections';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;

  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.setHeader('Allow', ['GET', 'DELETE']);
    return res.status(405).end('Method Not Allowed');
  }

  try {
    if (req.method === 'DELETE') {
      const service = req.query.service;
      const validService =
        typeof service === 'string' &&
        GOOGLE_WORKSPACE_SERVICES.some((candidate) => candidate.id === service);
      if (!validService) {
        return res.status(400).json({ error: 'Invalid Workspace service' });
      }
      const reset = await resetGoogleWorkspaceConnection(
        service as GoogleWorkspaceServiceId,
        session.username,
      );
      const connections = await getGoogleWorkspaceConnections(session.username);
      return res.status(200).json({ reset, connections });
    }
    const connections = await getGoogleWorkspaceConnections(session.username);
    return res.status(200).json({ connections });
  } catch (error) {
    const status =
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number'
        ? error.status
        : 503;
    if (status === 409) {
      return res.status(409).json({
        error:
          error instanceof Error
            ? error.message
            : 'Workspace authorization is currently in use',
      });
    }
    console.error('Failed to load Google Workspace connection state', error);
    return res.status(503).json({
      error:
        req.method === 'DELETE'
          ? 'Google Workspace authorization reset is temporarily unavailable'
          : 'Google Workspace connection status is temporarily unavailable',
    });
  }
}
