import type { NextApiRequest, NextApiResponse } from 'next';

import { sanitizeConversationAssistantReplays } from '@/utils/app/conversationReplay';
import { extractImageReferences } from '@/utils/app/imageHandler';
import { getSession } from '@/utils/auth/session';

import { touchImage } from '../session/imageStorage';

import { deleteConversationForUser } from '@/server/session/conversationDeletion';
import {
  ConversationWriteError,
  saveConversationForUser,
  readConversationForUser,
} from '@/server/session/conversationStore';
import { sessionKey, jsonGet, jsonSetWithExpiry } from '@/server/session/redis';
import { clampConversations } from '@/server/session/sanitize';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

/**
 * Endpoint for conversation operations:
 * GET: Get latest conversation state including any async job results.
 * PUT: Save conversation state.
 * DELETE: Delete a conversation.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await getSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid conversation ID' });
  }

  if (req.method === 'PUT') {
    const updatedData = req.body;

    try {
      // Server-authoritative timestamp
      const dataToSave = await saveConversationForUser(
        session.username,
        id,
        (current) => {
          if (
            current?.updatedAt &&
            updatedData.updatedAt &&
            current.updatedAt > updatedData.updatedAt
          ) {
            throw new ConversationWriteError('conflict', current);
          }
          return sanitizeConversationAssistantReplays({
            ...current,
            ...updatedData,
            updatedAt: Date.now(),
          });
        },
        true,
      );

      // Touch images referenced in the conversation to extend their TTL
      try {
        if (dataToSave.messages && Array.isArray(dataToSave.messages)) {
          const imageIds = extractImageReferences(dataToSave.messages);
          if (imageIds.length > 0) {
            console.log(
              `Touching ${imageIds.length} images for conversation ${id}`,
            );
            await Promise.all(
              imageIds.map((imageId) => touchImage(imageId, session.username)),
            );
          }
        }
      } catch (imageError) {
        // Log error but don't fail the request - image TTL extension is best-effort
        console.error('Failed to touch images:', imageError);
      }

      // Membership and the authoritative record were saved atomically above.

      // Also update the user's conversationHistory list for cross-device synchronization
      try {
        const conversationHistoryKey = sessionKey([
          'user',
          session.username,
          'conversationHistory',
        ]);
        const currentHistory = (await jsonGet(conversationHistoryKey)) || [];

        // Ensure it's an array
        const historyArray = Array.isArray(currentHistory)
          ? currentHistory
          : [];

        // Remove existing conversation if present (to update it)
        const filteredHistory = historyArray.filter((c: any) => c.id !== id);

        // Add updated conversation to the list
        const updatedHistory = [...filteredHistory, dataToSave];

        // Clamp and clean the history
        const cleanedHistory = clampConversations(updatedHistory);

        // Save back to Redis
        await jsonSetWithExpiry(
          conversationHistoryKey,
          cleanedHistory,
          60 * 60 * 24 * 7,
        );
      } catch (historyError) {
        // Log error but don't fail the request - conversationHistory sync is best-effort
        console.error('Failed to update conversationHistory:', historyError);
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      if (error instanceof ConversationWriteError) {
        return res.status(error.reason === 'forbidden' ? 403 : 409).json({
          error: error.message,
          ...(error.serverState ? { serverState: error.serverState } : {}),
        });
      }
      console.error('Error saving conversation:', error);
      return res.status(500).json({ error: 'Failed to save conversation' });
    }
  } else if (req.method === 'DELETE') {
    try {
      const deleted = await deleteConversationForUser(session.username, id);
      if (!deleted) {
        return res.status(403).json({
          error: 'Forbidden: You do not have access to this conversation',
        });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error deleting conversation:', error);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  } else if (req.method === 'GET') {
    try {
      // Fetch the data and its authorization from one Redis snapshot.
      const conversationData = await readConversationForUser(
        session.username,
        id,
      );

      if (conversationData) {
        const sanitized =
          sanitizeConversationAssistantReplays(conversationData);
        return res.status(200).json(sanitized);
      }

      // Check for any pending/completed async jobs for this conversation
      const jobKey = sessionKey(['conversation-job', id]);
      const jobData = await jsonGet(jobKey);

      if (jobData && typeof jobData === 'object' && 'messages' in jobData) {
        const sanitizedJobData = sanitizeConversationAssistantReplays({
          id,
          name: '',
          folderId: null,
          messages: (jobData as any).messages || [],
        });
        // Return the full conversation state from the job
        return res.status(200).json({
          conversationId: id,
          messages: sanitizedJobData.messages,
          status: (jobData as any).status || 'completed',
        });
      }

      // No conversation found, return empty state
      return res.status(404).json({ error: 'Conversation not found' });
    } catch (error) {
      if (error instanceof ConversationWriteError)
        return res.status(403).json({ error: error.message });
      console.error('Error fetching conversation:', error);
      return res.status(500).json({ error: 'Failed to fetch conversation' });
    }
  } else {
    res.setHeader('Allow', ['GET', 'PUT', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
}
