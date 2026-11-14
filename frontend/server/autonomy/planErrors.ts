// Only these application-owned messages may cross the planning API boundary.
// Provider bodies, exceptions and model diagnostics can contain private data.
const failures = {
  settings_unavailable: [
    503,
    'Your Autonomy settings could not be loaded. Refresh Autonomy, then preview again.',
  ],
  planning_unreachable: [
    503,
    'The automation planning service could not be reached. Check the backend service, then preview again.',
  ],
  planning_unavailable: [
    503,
    'Automation planning is unavailable on the backend. Check that the frontend and backend versions match, then preview again.',
  ],
  service_authentication: [
    502,
    'The backend rejected access to automation planning. Check the internal service authentication settings, then preview again.',
  ],
  planning_busy: [
    429,
    'The automation planner is busy or has reached its request limit. Wait a moment, then preview again.',
  ],
  planning_timeout: [
    504,
    'The automation preview timed out. Your instructions are still here; try previewing again.',
  ],
  model_request_rejected: [
    502,
    'The model service rejected the planning request. Check the model configuration and supported request controls, then preview again.',
  ],
  model_failed: [
    502,
    'The model service failed to complete the automation preview. Check the model service, then preview again.',
  ],
  capabilities_unavailable: [
    503,
    'Daedalus could not check which service operations are available for automation. Check the backend and connected services, then preview again.',
  ],
  invalid_response: [
    502,
    'The planner returned an unreadable response. Your instructions are still here; preview again, and check the model service if this repeats.',
  ],
  incomplete_response: [
    502,
    'The planner stopped before completing the preview. Your instructions are still here; preview again, and check the model service if this repeats.',
  ],
  oversized_response: [
    502,
    'The planner returned a response too large to process. Try a more focused request, then preview again.',
  ],
  invalid_plan: [
    502,
    'The planner returned an automation with invalid or unsupported settings. Review your instructions and preview again; if this repeats, check the model service.',
  ],
  operation_unavailable: [
    422,
    'This automation is blocked because a required service operation is unavailable for unattended work. Check the connected service access and unattended approval settings, then preview again to confirm availability.',
  ],
  settings_changed: [
    409,
    'Settings changed after this preview. Preview your instructions again to review the current settings before saving.',
  ],
  save_failed: [
    400,
    'Could not save this plan. Preview your instructions again before saving.',
  ],
} as const;

export type PlanningFailureCode = keyof typeof failures;

export class PlanningFailure extends Error {
  readonly status: number;

  constructor(
    readonly code: PlanningFailureCode,
    readonly upstreamStatus?: number,
  ) {
    const [status, message] = failures[code];
    super(message);
    this.name = 'PlanningFailure';
    this.status = status;
  }
}

export function planningHttpFailure(
  status: number,
  endpoint: 'plan' | 'capabilities' = 'plan',
): PlanningFailure {
  if (status === 401 || status === 403)
    return new PlanningFailure('service_authentication', status);
  if (status === 404)
    return new PlanningFailure('planning_unavailable', status);
  if (status === 429) return new PlanningFailure('planning_busy', status);
  if (status === 408 || status === 504)
    return new PlanningFailure('planning_timeout', status);
  if (status === 503 || endpoint === 'capabilities')
    return new PlanningFailure('capabilities_unavailable', status);
  return new PlanningFailure(
    status >= 400 && status < 500 ? 'model_request_rejected' : 'model_failed',
    status,
  );
}
