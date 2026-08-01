import {
  GOOGLE_WORKSPACE_SERVICES,
  type GoogleWorkspaceConnection,
  type GoogleWorkspaceServiceId,
} from '@/utils/app/googleWorkspace';

import { buildNatSessionId } from '@/server/chat/natMessages';
import { getRedis } from '@/server/session/redis';
import { createHash } from 'node:crypto';

const TOKEN_BUCKETS: Record<GoogleWorkspaceServiceId, string> = {
  gmail: 'gmail-mcp-oauth',
  calendar: 'calendar-mcp-oauth',
  drive: 'drive-mcp-oauth',
  docs: 'docs-mcp-oauth',
  sheets: 'sheets-mcp-oauth',
  slides: 'slides-mcp-oauth',
};

export function googleWorkspaceTokenKey(
  serviceId: GoogleWorkspaceServiceId,
  username: string,
): string {
  // Pinned NAT 1.8 ObjectStoreTokenStorage hashes its user id and writes the
  // result as tokens/<sha256>. Mirror only that key contract so this status
  // endpoint can use EXISTS without retrieving OAuth token contents.
  const natUserId = buildNatSessionId(username);
  const userHash = createHash('sha256').update(natUserId).digest('hex');
  return `nat/object_store/${TOKEN_BUCKETS[serviceId]}/tokens/${userHash}`;
}

export async function getGoogleWorkspaceConnections(
  username: string,
): Promise<GoogleWorkspaceConnection[]> {
  const redis = getRedis();
  const keys = GOOGLE_WORKSPACE_SERVICES.map((service) =>
    googleWorkspaceTokenKey(service.id, username),
  );
  const results = await redis
    .pipeline(keys.map((key) => ['exists', key]))
    .exec();

  if (!results) {
    throw new Error('Redis did not return Google Workspace connection state');
  }

  return GOOGLE_WORKSPACE_SERVICES.map((service, index) => {
    const [error, value] = results[index] || [];
    if (error) throw error;
    return {
      id: service.id,
      label: service.label,
      description: service.description,
      authorizationSaved: Number(value) > 0,
    };
  });
}
