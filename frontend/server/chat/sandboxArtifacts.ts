const ARTIFACT_REF_MARKER = 'DAEDALUS_SANDBOX_ARTIFACT_REF_V1:';
const SAFE_REF_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const MARKER_LINE = new RegExp(
  `^${ARTIFACT_REF_MARKER}([A-Za-z0-9_-]+)\\r?$`,
  'gm',
);

export interface SandboxArtifactRef {
  version: 1;
  documentId: string;
  sessionId: string;
  sourcePath: string;
  filename: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
}

function decodeMarker(encoded: string): unknown {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded) return null;
    return JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
}

function validRelativePath(value: string): boolean {
  if (!value || value.length > 1024 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.includes('\\')) return false;
  return value
    .split('/')
    .every((part) => Boolean(part) && part !== '.' && part !== '..');
}

function normalizeArtifact(value: unknown): SandboxArtifactRef | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SandboxArtifactRef>;
  if (
    candidate.version !== 1 ||
    typeof candidate.documentId !== 'string' ||
    !SAFE_REF_ID_PATTERN.test(candidate.documentId) ||
    typeof candidate.sessionId !== 'string' ||
    !SAFE_REF_ID_PATTERN.test(candidate.sessionId) ||
    typeof candidate.sourcePath !== 'string' ||
    !validRelativePath(candidate.sourcePath) ||
    typeof candidate.filename !== 'string' ||
    !candidate.filename ||
    candidate.filename.includes('/') ||
    candidate.filename.includes('\\') ||
    candidate.filename !== candidate.sourcePath.split('/').at(-1) ||
    typeof candidate.mimeType !== 'string' ||
    !candidate.mimeType ||
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 1 ||
    typeof candidate.downloadUrl !== 'string'
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(candidate.downloadUrl, 'https://daedalus.invalid');
  } catch {
    return null;
  }
  if (
    url.origin !== 'https://daedalus.invalid' ||
    url.pathname !== '/api/session/documentStorage' ||
    url.hash ||
    url.searchParams.size !== 2 ||
    url.searchParams.get('documentId') !== candidate.documentId ||
    url.searchParams.get('sessionId') !== candidate.sessionId
  ) {
    return null;
  }

  return candidate as SandboxArtifactRef;
}

function artifactToolStep(step: any): boolean {
  if (step?.payload?.event_type !== 'TOOL_END') return false;
  const names = [step?.payload?.name, step?.function_ancestry?.function_name];
  return names.some(
    (name) => typeof name === 'string' && name.includes('llm_sandbox'),
  );
}

/**
 * Remove the private marker from a sandbox TOOL_END event and retain only its
 * validated, owner-scoped reference in step metadata.
 */
export function sanitizeSandboxArtifactStep(step: any): SandboxArtifactRef[] {
  if (!artifactToolStep(step)) return [];
  const output = step?.payload?.data?.output;
  if (typeof output !== 'string') return [];

  const artifacts: SandboxArtifactRef[] = [];
  const visibleOutput = output.replace(
    MARKER_LINE,
    (_match, encoded: string) => {
      const artifact = normalizeArtifact(decodeMarker(encoded));
      if (artifact) artifacts.push(artifact);
      return '';
    },
  );
  step.payload.data.output = visibleOutput.replace(/\n{3,}/g, '\n\n').trim();
  const originalPayload = step.payload.metadata?.original_payload;
  if (originalPayload && typeof originalPayload.payload === 'string') {
    originalPayload.payload = originalPayload.payload
      .replace(MARKER_LINE, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (artifacts.length === 0) return [];

  step.payload.metadata = {
    ...(step.payload.metadata || {}),
    sandboxArtifacts: artifacts,
  };
  return artifacts;
}

export function sandboxArtifactsFromSteps(steps: any[]): SandboxArtifactRef[] {
  const artifacts = new Map<string, SandboxArtifactRef>();
  for (const step of Array.isArray(steps) ? steps : []) {
    const values = step?.payload?.metadata?.sandboxArtifacts;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      const artifact = normalizeArtifact(value);
      if (artifact) artifacts.set(artifact.documentId, artifact);
    }
  }
  return Array.from(artifacts.values());
}

function escapedMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1');
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceSandboxRelativeLink(
  content: string,
  artifact: SandboxArtifactRef,
): string {
  const targets = new Set([
    artifact.sourcePath,
    `./${artifact.sourcePath}`,
    artifact.filename,
    `./${artifact.filename}`,
    encodeURI(artifact.sourcePath),
    `./${encodeURI(artifact.sourcePath)}`,
    encodeURI(artifact.filename),
    `./${encodeURI(artifact.filename)}`,
  ]);
  let result = content;
  for (const target of Array.from(targets).sort(
    (left, right) => right.length - left.length,
  )) {
    result = result.replace(
      new RegExp(`\\]\\(${escapedRegExp(target)}\\)`, 'g'),
      `](${artifact.downloadUrl})`,
    );
  }
  return result;
}

/**
 * Guarantee that every successfully published artifact has a reachable link in
 * the final assistant response, even when the model emitted a sandbox-relative
 * Markdown link or omitted the link entirely.
 */
export function attachSandboxArtifacts(
  response: string,
  artifacts: SandboxArtifactRef[],
): string {
  let content = (response || '').replace(MARKER_LINE, '').trim();
  const unique = new Map<string, SandboxArtifactRef>();
  for (const value of artifacts) {
    const artifact = normalizeArtifact(value);
    if (artifact) unique.set(artifact.documentId, artifact);
  }
  if (unique.size === 0) return content;

  for (const artifact of unique.values()) {
    content = replaceSandboxRelativeLink(content, artifact);
  }
  const missing = Array.from(unique.values()).filter(
    (artifact) => !content.includes(`](${artifact.downloadUrl})`),
  );
  if (missing.length === 0) return content;

  const downloads = missing
    .map(
      (artifact) =>
        `- [${escapedMarkdownLabel(artifact.filename)}](${
          artifact.downloadUrl
        })`,
    )
    .join('\n');
  return `${content}${content ? '\n\n' : ''}### Downloads\n\n${downloads}`;
}
