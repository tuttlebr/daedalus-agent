import {
  GOOGLE_WORKSPACE_SERVICES,
  type GoogleWorkspaceConnection,
  type GoogleWorkspaceServiceId,
} from '@/utils/app/googleWorkspace';

import { buildNatSessionId } from '@/server/chat/natMessages';
import { getRedis } from '@/server/session/redis';
import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

// NAT 1.8 derives Context.user_id from the nat-session cookie with UUID v5
// before passing it to ObjectStoreTokenStorage. Keep this namespace derivation
// aligned with nat.data_models.user_info.UserInfo.
const NAT_USER_ID_NAMESPACE = uuidv5('nemo-agent-toolkit', uuidv5.DNS);

const TOKEN_BUCKETS: Record<GoogleWorkspaceServiceId, string> = {
  gmail: 'gmail-mcp-oauth',
  calendar: 'calendar-mcp-oauth',
  docs: 'docs-mcp-oauth',
};

export function googleWorkspaceTokenKey(
  serviceId: GoogleWorkspaceServiceId,
  username: string,
): string {
  // UserManager first maps the session cookie to a deterministic UUID. The
  // token store then hashes that runtime user ID and writes tokens/<sha256>.
  // Mirror only those key contracts so this endpoint can use EXISTS without
  // retrieving OAuth token contents.
  const natSessionId = buildNatSessionId(username);
  const natUserId = uuidv5(natSessionId, NAT_USER_ID_NAMESPACE);
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
