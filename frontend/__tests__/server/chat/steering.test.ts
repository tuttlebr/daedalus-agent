import {
  forwardSteeringCommand,
  validateSteeringCommand,
} from '@/server/chat/steering';
import type { AsyncJobRequest } from '@/server/chat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const command = {
  jobId: 'job-1',
  commandId: '00000000-0000-4000-8000-000000000001',
  instruction: 'Keep the completed results and focus on storage.',
};
const job: AsyncJobRequest = {
  jobId: command.jobId,
  userId: 'alice',
  natBaseUrl: 'http://backend.test:8000',
  executionMode: 'stream',
  messages: [],
  conversationId: 'conversation-1',
};

afterEach(() => vi.unstubAllEnvs());

describe('live steering', () => {
  it('validates the command and bounds UTF-8 bytes', () => {
    expect(validateSteeringCommand(command)).toEqual(command);
    expect(() =>
      validateSteeringCommand({ ...command, instruction: ' ' }),
    ).toThrow();
    expect(() =>
      validateSteeringCommand({ ...command, instruction: '💬'.repeat(4001) }),
    ).toThrow();
    expect(() =>
      validateSteeringCommand({ ...command, jobId: '../another-run' }),
    ).toThrow();
  });

  it('rejects another owner and non-agent jobs before making any backend request', async () => {
    const request = vi.fn();
    await expect(
      forwardSteeringCommand('bob', command, job, request),
    ).rejects.toThrow('not found');
    await expect(
      forwardSteeringCommand(
        'alice',
        command,
        { ...job, executionMode: 'document_ingest' },
        request,
      ),
    ).rejects.toThrow('not found');
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the saved backend and authenticated owner instead of client routing data', async () => {
    vi.stubEnv('DAEDALUS_INTERNAL_API_TOKEN', 'fixture-internal-token');
    const request = vi.fn().mockResolvedValue({ ok: true });
    await forwardSteeringCommand('alice', command, job, request);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe('http://backend.test:8000/v1/runs/job-1/control');
    expect(init.headers).toMatchObject({
      'x-user-id': 'alice',
      'x-daedalus-internal-token': 'fixture-internal-token',
      'x-conversation-id': 'conversation-1',
    });
    expect(JSON.parse(init.body)).toEqual({
      type: 'steer',
      command_id: command.commandId,
      instruction: command.instruction,
    });
  });

  it('reports a completed run instead of acknowledging an undelivered direction', async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(
      forwardSteeringCommand('alice', command, job, request),
    ).rejects.toThrow('finished');
  });
});
