export const MCP_APPROVAL_MARKER_PATTERN =
  /<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->/;

export interface McpApprovalMarker {
  version: 1;
  requestId: string;
  serverName: string;
  toolName: string;
  target: string;
  summary: string;
  argumentsSha256: string;
}

const LEGACY_APPROVAL_PATTERN =
  /Approval scope: action_type=`mcp_mutation`,\s*target=`([^`]+)`,\s*server_name=`([^`]+)`,\s*tool_name=`([^`]+)`,\s*approval_request_id=`([A-Za-z0-9_-]{12,128})`,\s*arguments_sha256=`([0-9a-f]{64})`\./;

function decodeBase64Url(value: string): string {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(
    (4 - (value.length % 4)) % 4,
  )}`;
  const bytes = Uint8Array.from(globalThis.atob(padded), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

export function parseMcpApprovalMarker(
  value: unknown,
): McpApprovalMarker | null {
  if (typeof value !== 'string') return null;
  const encoded = value.match(MCP_APPROVAL_MARKER_PATTERN)?.[1];
  if (encoded) {
    try {
      const parsed = JSON.parse(decodeBase64Url(encoded)) as McpApprovalMarker;
      if (
        parsed?.version !== 1 ||
        !/^[A-Za-z0-9_-]{12,128}$/.test(parsed.requestId) ||
        typeof parsed.serverName !== 'string' ||
        !parsed.serverName.trim() ||
        typeof parsed.toolName !== 'string' ||
        !parsed.toolName.trim() ||
        typeof parsed.target !== 'string' ||
        !parsed.target.trim() ||
        typeof parsed.summary !== 'string' ||
        !parsed.summary.trim() ||
        !/^[0-9a-f]{64}$/.test(parsed.argumentsSha256)
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // Rolling compatibility: turn already-persisted verbose reviews from the
  // previous release into the same button card. The decision API trusts only
  // the authenticated server-side pending record; none of these fields are
  // sent back as execution authority.
  if (!value.includes('Arguments for review') || !value.includes('Proceed?')) {
    return null;
  }
  const legacy = value.match(LEGACY_APPROVAL_PATTERN);
  if (!legacy) return null;
  const [, target, serverName, toolName, requestId, argumentsSha256] = legacy;
  return {
    version: 1,
    requestId,
    serverName,
    toolName,
    target,
    summary:
      serverName === 'docs_mcp_server' && toolName === 'update_doc'
        ? `Update Google document ${target}`
        : `Run ${serverName}.${toolName} on ${target}`,
    argumentsSha256,
  };
}

export function isMcpApprovalMarkerMessage(value: unknown): boolean {
  return parseMcpApprovalMarker(value) !== null;
}
