import { publishSyncEvent } from '@/utils/sync/publish';

import type {
  AutonomyConfig,
  AutonomyState,
  Responsibility,
  TaskKind,
} from '@/types/autonomy';

import { applyConfigPatch, defaultConfig } from './config';

import { updateJsonAtomically } from '@/server/atomicJson';
import { getRedis } from '@/server/session/redis';
import { createHash, randomUUID } from 'node:crypto';

export function autonomyKey(userId: string, name: string): string {
  return `autonomy:${userId}:charter:${name}`;
}
export function emptyState(): AutonomyState {
  return {
    version: 2,
    actions: {},
    schedules: {},
    records: {},
    proposals: {},
    notes: {},
    runs: [],
    summaries: [],
    reported: {},
  };
}
async function notify(userId: string) {
  await publishSyncEvent(userId, {
    type: 'autonomy_status',
    timestamp: Date.now(),
    data: { charter: true },
  });
}
export async function getConfig(userId: string): Promise<AutonomyConfig> {
  const raw = await getRedis().get(autonomyKey(userId, 'config'));
  return raw
    ? applyConfigPatch(defaultConfig(), JSON.parse(raw))
    : defaultConfig();
}
export async function saveConfig(
  userId: string,
  patch: unknown,
): Promise<AutonomyConfig> {
  const config = await updateJsonAtomically<AutonomyConfig>(
    autonomyKey(userId, 'config'),
    (current) => applyConfigPatch(current || defaultConfig(), patch),
  );
  await notify(userId);
  return config!;
}
export async function getState(userId: string): Promise<AutonomyState> {
  const raw = await getRedis().get(autonomyKey(userId, 'state'));
  if (!raw) return emptyState();
  const state = JSON.parse(raw) as AutonomyState;
  if (
    state.version !== 2 ||
    !state.actions ||
    !Array.isArray(state.runs) ||
    !Array.isArray(state.summaries)
  )
    throw new Error('Invalid charter state');
  return state;
}
const kinds: Record<Responsibility, TaskKind> = {
  calendar: 'calendar_discovery',
  lighting: 'sports_discovery',
  cluster: 'cluster_maintenance',
  evolution: 'evolution',
};
export async function requestResponsibility(
  userId: string,
  responsibility: unknown,
): Promise<string> {
  if (
    typeof responsibility !== 'string' ||
    !Object.hasOwn(kinds, responsibility)
  )
    throw new Error('Select an existing responsibility');
  const name = responsibility as Responsibility;
  const config = await getConfig(userId);
  if (!config.enabled || !config.responsibilities[name].enabled)
    throw new Error('Resume this responsibility before running it');
  const kind = kinds[name];
  const timestamp = Date.now();
  const id = `${kind}:${createHash('sha256')
    .update(`${kind}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 32)}`;
  let selectedId = id;
  await updateJsonAtomically<AutonomyState>(
    autonomyKey(userId, 'state'),
    (current) => {
      const state = current || emptyState();
      const existing = Object.values(state.actions).find(
        (item) =>
          item.kind === kind && ['pending', 'running'].includes(item.status),
      );
      if (existing) {
        selectedId = existing.id;
        return null;
      }
      if (
        Object.values(state.actions).filter((item) =>
          ['pending', 'running'].includes(item.status),
        ).length >= config.maxPendingActions
      )
        throw new Error('Pending action capacity reached');
      return {
        ...state,
        actions: {
          ...state.actions,
          [id]: {
            id,
            kind,
            responsibility: name,
            status: 'pending',
            dueAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
            attempts: 0,
            payload: {},
            outcome: null,
          },
        },
      };
    },
  );
  await notify(userId);
  return selectedId;
}
export async function cancelAction(
  userId: string,
  actionId: string,
): Promise<boolean> {
  let found = false;
  await updateJsonAtomically<AutonomyState>(
    autonomyKey(userId, 'state'),
    async (current) => {
      const item = current?.actions[actionId];
      if (!current || !item || !['pending', 'running'].includes(item.status))
        return null;
      found = true;
      if (item.status === 'running' && item.runId) {
        await getRedis().set(
          autonomyKey(userId, `cancel:${item.runId}`),
          '1',
          'EX',
          7200,
        );
      }
      let records = { ...current.records };
      if (
        item.kind === 'calendar_event' &&
        typeof item.payload.sourceKey === 'string'
      ) {
        records = {
          ...records,
          [item.payload.sourceKey]: {
            ...(Object.hasOwn(records, item.payload.sourceKey)
              ? (records[item.payload.sourceKey] as Record<string, unknown>)
              : {}),
            dismissed: true,
            updatedAt: Date.now(),
          },
        };
      }
      return {
        ...current,
        records,
        actions: {
          ...current.actions,
          [actionId]: {
            ...item,
            // Keep dispatched work running until the worker records whether
            // remote effects occurred; cancellation is not proof of no effect.
            status: item.status === 'running' ? 'running' : 'cancelled',
            cancelledByUser: true,
            updatedAt: Date.now(),
          },
        },
      };
    },
  );
  if (found) await notify(userId);
  return found;
}
export async function reviewProposal(
  userId: string,
  proposalId: string,
  status: 'accepted' | 'dismissed',
): Promise<boolean> {
  let found = false;
  await updateJsonAtomically<AutonomyState>(
    autonomyKey(userId, 'state'),
    (current) => {
      const proposal = current?.proposals[proposalId];
      if (!current || !proposal) return null;
      found = true;
      return {
        ...current,
        proposals: {
          ...current.proposals,
          [proposalId]: {
            ...proposal,
            status,
            updatedAt: Date.now(),
          },
        },
      };
    },
  );
  if (found) await notify(userId);
  return found;
}
