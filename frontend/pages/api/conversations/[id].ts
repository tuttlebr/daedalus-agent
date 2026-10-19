import type { NextApiRequest, NextApiResponse } from 'next';

import {
  conversationRevision,
  withConversationRevision,
} from '@/utils/app/conversationRevision';
import { extractImageReferences } from '@/utils/app/imageHandler';
import { getSession } from '@/utils/auth/session';
import { publishSyncEvent } from '@/utils/sync/publish';

import { touchImage } from '../session/imageStorage';

import { deleteConversationForUser } from '@/server/session/conversationDeletion';
import {
  ConversationWriteError,
  saveConversationForUser,
  readConversationForUser,
} from '@/server/session/conversationStore';
import { v4 as uuidv4 } from 'uuid';

// The token of a record reserved by a chat request and never saved since
// (server/session/conversationStore.ts reserveConversationForUser).
const RESERVED_REVISION = conversationRevision({ updatedAt: 0 });

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
 *
 * Saves use optimistic concurrency with a server-issued token. GET and every
 * successful PUT return the record's `revision`; a PUT sends the revision its
 * copy was derived from as `baseRevision` and is rejected with 409 (and the
 * current record) when the stored revision differs. Browser clocks are never
 * compared. Records written without a revision (older saves, worker
 * finalization, chat reservation) are identified by their server-stamped
 * `updatedAt` (see conversationRevision).
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
    // The body is merged over the stored record; anything but a JSON object
    // would either throw or persist array indices as conversation fields.
    if (
      !updatedData ||
      typeof updatedData !== 'object' ||
      Array.isArray(updatedData)
    ) {
      return res.status(400).json({ error: 'Expected a conversation object' });
    }

    const hasBase = Object.prototype.hasOwnProperty.call(
      updatedData,
      'baseRevision',
    );
    const {
      baseRevision,
      revision: _clientRevision,
      ...fields
    } = updatedData as Record<string, any>;
    if (
      hasBase &&
      baseRevision !== null &&
      (typeof baseRevision !== 'string' || !baseRevision)
    ) {
      return res.status(400).json({ error: 'Invalid base revision' });
    }

    try {
      const dataToSave = await saveConversationForUser(
        session.username,
        id,
        (current) => {
          // A missing record is created as before: legacy history-only
          // conversations have no record to compare with. A browser that has
          // not saved a new conversation yet sends null; its first chat
          // request may already have reserved the record (empty, stamped 0),
          // and that reservation is what this save replaces.
          const expected = baseRevision ?? RESERVED_REVISION;
          const conflict = hasBase
            ? current !== null && conversationRevision(current) !== expected
            : // Clients that predate revisions send their own updatedAt.
              Boolean(
                current?.updatedAt &&
                  fields.updatedAt &&
                  current.updatedAt > fields.updatedAt,
              );
          if (conflict) {
            throw new ConversationWriteError(
              'conflict',
              withConversationRevision(current!),
            );
          }
          return {
            ...current,
            ...fields,
            // Server-authoritative timestamp and a fresh concurrency token.
            updatedAt: Date.now(),
            revision: uuidv4(),
          };
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

      // History reads reconcile these owned records directly. Writing a second
      // read/modify/write history document here lost concurrent conversations.

      return res.status(200).json({
        success: true,
        revision: dataToSave.revision,
        updatedAt: dataToSave.updatedAt,
      });
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

      // Other open sessions remove it too (best-effort; history reads are
      // authoritative).
      await publishSyncEvent(session.username, {
        type: 'conversation_deleted',
        timestamp: Date.now(),
        data: { conversationId: id },
      });

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
        return res.status(200).json(withConversationRevision(conversationData));
      }
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
