import type { SourcePolicy } from './sourcePolicy';

export type AutonomyRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'waiting_approval';

export type AutonomyTrigger = 'manual' | 'scheduled' | 'goal' | string;

export interface AutonomyQueuedRequest {
  id: string;
  trigger: AutonomyTrigger;
  goalId?: string | null;
  prompt?: string;
  requestedBy: string;
  createdAt: number;
  position: number;
}

export interface AutonomyConfig {
  enabled: boolean;
  userId: string;
  mode: 'hybrid' | 'research_feed' | 'task_executor' | string;
  runtime: 'dedicated_worker' | string;
  actionPolicy:
    | 'broad_autonomy'
    | 'read_memory_only'
    | 'low_risk_writes'
    | string;
  intervalSeconds: number;
  maxRunsStored: number;
  maxFeedItems: number;
  /** Drop feed items that repeat something surfaced within the window. */
  feedDedupeEnabled?: boolean;
  /** Recency window (days) the worker dedupes new feed items against. */
  feedDedupeWindowDays?: number;
  sourcePolicy?: SourcePolicy;
  lastScheduledRunAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AutonomyGoal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'paused' | 'completed';
  priority: number;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
}

export interface AutonomyRun {
  id: string;
  userId: string;
  trigger: AutonomyTrigger;
  goalId?: string | null;
  prompt?: string;
  requestedBy: string;
  status: AutonomyRunStatus;
  summary: string;
  error?: string;
  feedItemIds: string[];
  metrics: Record<string, unknown>;
  createdAt: number;
  startedAt?: number | null;
  completedAt?: number | null;
  updatedAt: number;
}

export interface AutonomyEvent {
  id: string;
  runId: string;
  type: string;
  level: 'info' | 'warn' | 'error' | string;
  message: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface AutonomyFeedItem {
  id: string;
  runId: string;
  lane: 'known' | 'adjacent' | 'scout' | string;
  title: string;
  bluf: string;
  body: string;
  sourceUrl?: string;
  confidence: 'high' | 'medium' | 'low' | string;
  confidenceReason?: string;
  /** Stable content fingerprint stamped by the worker for de-duplication. */
  fingerprint?: string;
  /** Stable source/topic key used to suppress repeats and link updates. */
  threadKey?: string;
  /** Prior feed item this entry materially updates, when applicable. */
  updateOfFeedItemId?: string;
  updateOfTitle?: string;
  updateReason?: string;
  createdAt: number;
}

export interface AutonomyApproval {
  id: string;
  runId: string;
  status: 'pending' | 'approved' | 'denied';
  action: string;
  reason: string;
  actionType: string;
  target?: string;
  serverName?: string;
  toolName?: string;
  approvalRequestId?: string;
  /** Canonical MCP arguments with credential-like fields redacted. */
  argumentsPreview?: string;
  argumentsSha256?: string;
  risk: 'low' | 'medium' | 'high' | string;
  authUrl?: string;
  oauthState?: string;
  createdAt: number;
  resolvedAt?: number | null;
}
