export type Responsibility = 'calendar' | 'lighting' | 'cluster' | 'evolution';
export type TaskKind =
  | 'calendar_discovery'
  | 'calendar_event'
  | 'sports_discovery'
  | 'game_lighting'
  | 'cluster_maintenance'
  | 'evolution'
  | 'daily_summary';
export interface ResponsibilityConfig {
  enabled: boolean;
  intervalSeconds: number;
}
export interface AutonomyConfig {
  version: 2;
  enabled: boolean;
  timezone: 'America/Detroit';
  responsibilities: {
    calendar: ResponsibilityConfig & {
      calendarId: string;
      sources: string[];
      preferences: string;
      reminderMinutes: number[];
    };
    lighting: ResponsibilityConfig & {
      scene: string;
      catchUpMinutes: number;
      lightIds: string[];
    };
    cluster: ResponsibilityConfig & {
      contexts: string[];
      excludedNamespaces: string[];
      configurationSource: 'cluster_managed';
      lanVerificationSource: string;
      maintenancePolicy: string;
    };
    evolution: ResponsibilityConfig;
  };
  summary: { time: string; destination: 'autonomy_dashboard' };
  expansionPolicy: 'propose';
  maxToolCalls: number;
  maxRunSeconds: number;
  maxAttempts: number;
  maxPendingActions: number;
  maxRunsStored: number;
  maxSummariesStored: number;
}
export interface Outcome {
  status: 'completed' | 'partial' | 'failed' | 'deferred' | 'uncertain';
  summary: string;
  mutationAttempted?: boolean;
  evidence?: { description: string; reference?: string }[];
  externalId?: string;
  observedState?: Record<string, unknown>;
  skipped?: string[];
  recommendations?: string[];
}
export interface AutonomyAction {
  id: string;
  kind: TaskKind;
  responsibility: Responsibility | 'summary';
  status: string;
  dueAt: number;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  runId?: string;
  cancelledByUser?: boolean;
  payload: Record<string, unknown>;
  outcome: Outcome | null;
}
export interface AutonomyRun {
  id: string;
  actionId: string;
  kind: TaskKind;
  responsibility: Responsibility | 'summary';
  status: string;
  startedAt: number;
  completedAt: number | null;
  outcome: Outcome | null;
}
export interface Proposal {
  id: string;
  title: string;
  benefit: string;
  trigger: string;
  requiredAccess: string;
  actions: string;
  limits: string;
  status: 'proposed' | 'accepted' | 'dismissed';
  updatedAt: number;
}
export interface DailySummary {
  id: string;
  date: string;
  title: string;
  message: string;
  createdAt: number;
  items: {
    responsibility: string;
    status: string;
    summary?: string;
    actionId?: string;
    evidence?: Outcome['evidence'];
    skipped?: string[];
    recommendations?: string[];
    proposal?: Proposal;
  }[];
}
export interface AutonomyState {
  version: 2;
  actions: Record<string, AutonomyAction>;
  schedules: Record<string, number | string>;
  records: Record<string, unknown>;
  proposals: Record<string, Proposal>;
  notes: Record<string, string>;
  runs: AutonomyRun[];
  summaries: DailySummary[];
  reported: Record<string, { signature: string; updatedAt: number }>;
}
