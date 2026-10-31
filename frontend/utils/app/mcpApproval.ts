export const MCP_APPROVAL_MARKER_PATTERN =
  /<!--daedalus-mcp-approval:([A-Za-z0-9_-]+)-->/;
const MCP_APPROVAL_ESCAPED_MARKER_PATTERN =
  /&lt;!--daedalus-mcp-approval:([A-Za-z0-9_-]+)--&gt;/;

export interface McpApprovalMarker {
  version: 1;
  requestId: string;
  serverName: string;
  toolName: string;
  target: string;
  summary: string;
  argumentsSha256: string;
}

export interface McpApprovalResult {
  content: string;
}

export function parseMcpApprovalResult(
  value: unknown,
): McpApprovalResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const content = (value as Record<string, unknown>).content;
  return typeof content === 'string' ? { content } : undefined;
}

export function formatMcpApprovalResult(
  approval: Pick<McpApprovalMarker, 'serverName' | 'toolName' | 'target'>,
  result?: McpApprovalResult,
): string {
  const summary = `Approved operation completed: ${approval.serverName}.${approval.toolName} on ${approval.target}.`;
  if (!result)
    return `${summary}\n\nThe operation completed, but its output is unavailable.`;
  if (!result.content) return `${summary}\n\nThe operation returned no output.`;
  let output = result.content;
  try {
    output = JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    // Plain text is also a valid tool result.
  }
  output = output
    .replace(
      new RegExp(MCP_APPROVAL_MARKER_PATTERN.source, 'g'),
      '[untrusted approval marker omitted]',
    )
    .replace(
      new RegExp(MCP_APPROVAL_ESCAPED_MARKER_PATTERN.source, 'g'),
      '[untrusted approval marker omitted]',
    );
  // Remote output is data. Keep it inside a fence even if it contains Markdown.
  let fenceLength = 3;
  for (const match of output.matchAll(/`+/g))
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${summary}\n\n${fence}text\n${output}\n${fence}`;
}

/** A stale browser or job snapshot must not replace a delivered result with its gate. */
export function preferSavedMcpApprovalResult(
  saved: { metadata?: Record<string, unknown> },
  incoming: { content?: unknown },
): boolean {
  const requestId = saved.metadata?.mcpApprovalRequestId;
  return (
    typeof requestId === 'string' &&
    parseMcpApprovalMarker(incoming.content)?.requestId === requestId
  );
}

const HIGH_IMPACT_TOOL_PATTERN =
  /delete|remove|revoke|permission|role|identity|impersonat|admin|execute|restart|scale|shutdown/i;

export function requiresAdditionalMcpConfirmation(
  approval: Pick<McpApprovalMarker, 'serverName' | 'toolName'>,
): boolean {
  return (
    ['k8s_mcp_server', 'unifi_mcp_server'].includes(approval.serverName) ||
    HIGH_IMPACT_TOOL_PATTERN.test(approval.toolName)
  );
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
  const encoded = extractMcpApprovalMarkerText(value)?.match(
    MCP_APPROVAL_MARKER_PATTERN,
  )?.[1];
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

export function extractMcpApprovalMarkerText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const literal = value.match(MCP_APPROVAL_MARKER_PATTERN);
  if (literal) return literal[0];
  const escaped = value.match(MCP_APPROVAL_ESCAPED_MARKER_PATTERN);
  return escaped ? `<!--daedalus-mcp-approval:${escaped[1]}-->` : null;
}

export function isMcpApprovalMarkerMessage(value: unknown): boolean {
  return parseMcpApprovalMarker(value) !== null;
}
