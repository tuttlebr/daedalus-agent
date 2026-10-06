import { buildBackendUrlFromBase } from '@/utils/app/backendApi';

import { buildNatRequestHeaders } from './natMessages';
import type { AsyncJobRequest } from './types';

export interface SteeringCommand {
  jobId: string;
  commandId: string;
  instruction: string;
}

export function validateSteeringCommand(value: any): SteeringCommand {
  if (
    !value ||
    typeof value.jobId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.jobId) ||
    typeof value.commandId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.commandId,
    ) ||
    typeof value.instruction !== 'string' ||
    !value.instruction.trim() ||
    new TextEncoder().encode(value.instruction).length > 16_000
  ) {
    throw new Error('Invalid steering command');
  }
  return {
    jobId: value.jobId,
    commandId: value.commandId,
    instruction: value.instruction,
  };
}

export async function forwardSteeringCommand(
  userId: string,
  command: SteeringCommand,
  job: AsyncJobRequest | null,
  request: typeof fetch = fetch,
): Promise<void> {
  if (
    !job ||
    job.userId !== userId ||
    job.jobId !== command.jobId ||
    job.executionMode !== 'stream'
  ) {
    throw new Error('Active response not found');
  }
  const response = await request(
    buildBackendUrlFromBase(
      job.natBaseUrl,
      `/v1/runs/${encodeURIComponent(job.jobId)}/control`,
    ),
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        userId,
        { 'Content-Type': 'application/json' },
        job.natSessionId,
        job.timezone,
        job.conversationId,
      ),
      body: JSON.stringify({
        type: 'steer',
        command_id: command.commandId,
        instruction: command.instruction,
      }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404 || response.status === 409
        ? 'This response has finished or is not ready for steering'
        : 'The direction could not be accepted',
    );
  }
}

export async function forwardCancellation(job: AsyncJobRequest): Promise<void> {
  const response = await fetch(
    buildBackendUrlFromBase(
      job.natBaseUrl,
      `/v1/runs/${encodeURIComponent(job.jobId)}/control`,
    ),
    {
      method: 'POST',
      headers: buildNatRequestHeaders(
        job.userId,
        { 'Content-Type': 'application/json' },
        job.natSessionId,
        job.timezone,
        job.conversationId,
      ),
      body: JSON.stringify({ type: 'cancel', command_id: crypto.randomUUID() }),
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error('Backend cancellation failed');
  }
}
