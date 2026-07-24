import {
  attachSandboxArtifacts,
  sanitizeSandboxArtifactStep,
  sandboxArtifactsFromSteps,
  type SandboxArtifactRef,
} from '@/server/chat/sandboxArtifacts';
import { describe, expect, it } from 'vitest';

const artifact: SandboxArtifactRef = {
  version: 1,
  documentId: 'document-1',
  sessionId: 'sandbox-session-1',
  sourcePath: 'travel/alaska_cruise_2026.html',
  filename: 'alaska_cruise_2026.html',
  mimeType: 'text/html; charset=utf-8',
  size: 1234,
  downloadUrl:
    '/api/session/documentStorage?documentId=document-1&sessionId=sandbox-session-1',
};

function marker(value: unknown): string {
  return `DAEDALUS_SANDBOX_ARTIFACT_REF_V1:${Buffer.from(
    JSON.stringify(value),
  ).toString('base64url')}`;
}

function toolStep(value: unknown = artifact): any {
  const output = `Published.\n${marker(value)}\nDone.`;
  return {
    function_ancestry: { function_name: 'llm_sandbox_tool' },
    payload: {
      event_type: 'TOOL_END',
      name: 'llm_sandbox_tool',
      metadata: { original_payload: { payload: output } },
      data: { output },
    },
  };
}

describe('sandbox artifact chat handoff', () => {
  it('removes private markers and retains only validated references', () => {
    const step = toolStep();

    expect(sanitizeSandboxArtifactStep(step)).toEqual([artifact]);
    expect(step.payload.data.output).toBe('Published.\n\nDone.');
    expect(step.payload.metadata.original_payload.payload).not.toContain(
      'DAEDALUS_SANDBOX_ARTIFACT_REF_V1',
    );
    expect(sandboxArtifactsFromSteps([step, step])).toEqual([artifact]);
  });

  it('ignores forged external download URLs', () => {
    const step = toolStep({
      ...artifact,
      downloadUrl: 'https://attacker.example/file',
    });

    expect(sanitizeSandboxArtifactStep(step)).toEqual([]);
    expect(step.payload.data.output).not.toContain(
      'DAEDALUS_SANDBOX_ARTIFACT_REF_V1',
    );
  });

  it('replaces a sandbox-relative link with the authenticated UI link', () => {
    const response =
      'Your file is ready: [alaska_cruise_2026.html](alaska_cruise_2026.html)';

    const attached = attachSandboxArtifacts(response, [artifact]);

    expect(attached).toContain(
      `[alaska_cruise_2026.html](${artifact.downloadUrl})`,
    );
    expect(attached).not.toContain('](alaska_cruise_2026.html)');
    expect(attached).not.toContain('### Downloads');
  });

  it('adds a downloads section when the model omitted the link', () => {
    expect(attachSandboxArtifacts('The itinerary is ready.', [artifact])).toBe(
      `The itinerary is ready.\n\n### Downloads\n\n- [alaska_cruise_2026.html](${artifact.downloadUrl})`,
    );
  });
});
