import type { NextApiRequest, NextApiResponse } from 'next';

import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import { Logger } from '@/utils/logger';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';

import contract from '@/server/autonomy/contract.json';
import {
  PlanningFailure,
  planningHttpFailure,
  type PlanningFailureCode,
} from '@/server/autonomy/planErrors';
import {
  parseAutomationPlan,
  validateAutomationTools,
} from '@/server/autonomy/planning';
import { getConfig, saveAutomationPlan } from '@/server/autonomy/store';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';
import { randomUUID } from 'node:crypto';

export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };
const limit = ruleFromEnv('autonomy-plan', 'RATE_LIMIT_AUTONOMY_PLAN', 10, 60);
const logger = new Logger('autonomy-plan');
async function capabilities(
  username: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const response = await fetch(
      buildBackendUrlFromBase(
        buildBackendBaseUrlForMode(),
        '/internal/autonomy/capabilities',
      ),
      {
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
          : AbortSignal.timeout(25000),
        headers: withInternalBackendAuth({ 'x-user-id': username }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw planningHttpFailure(response.status, 'capabilities');
    }
    const result = await response.json();
    if (
      !Array.isArray(result.tools) ||
      result.tools.some((name: unknown) => typeof name !== 'string')
    )
      throw new Error('Invalid automation capabilities');
    return result.tools;
  } catch (error) {
    if (error instanceof PlanningFailure) throw error;
    throw new PlanningFailure('capabilities_unavailable');
  }
}
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const session = await requireAuthenticatedUser(req, res);
  if (!session) return;
  if (!['POST', 'PUT'].includes(req.method || '')) {
    res.setHeader('Allow', ['POST', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await enforceRateLimit(res, limit, session.username))) return;
  res.setHeader('Cache-Control', 'no-store');
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  let stage: PlanningFailureCode = 'settings_unavailable';
  let upstreamStatus: number | undefined;
  const fail = (error: unknown) => {
    const failure =
      error instanceof PlanningFailure ? error : new PlanningFailure(stage);
    logger.warn('Automation request failed', {
      requestId,
      operation: req.method === 'PUT' ? 'save' : 'preview',
      stage,
      code: failure.code,
      upstreamStatus: failure.upstreamStatus ?? upstreamStatus,
    });
    if (!res.destroyed)
      return res
        .status(failure.status)
        .json({ error: failure.message, code: failure.code });
  };
  if (req.method === 'PUT') {
    stage = 'save_failed';
    try {
      if (req.body?.type === 'automation') {
        stage = 'capabilities_unavailable';
        const available = await capabilities(session.username);
        stage = 'save_failed';
        validateAutomationTools(req.body.rule, available);
      }
      return res
        .status(200)
        .json(await saveAutomationPlan(session.username, req.body));
    } catch (error) {
      return fail(error);
    }
  }
  const instructions = req.body?.instructions;
  if (
    typeof instructions !== 'string' ||
    !instructions.trim() ||
    instructions.length > 4000
  )
    return res
      .status(400)
      .json({ error: 'Describe the automation in 4,000 characters or fewer.' });
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120_000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const current = await getConfig(session.username);
    const { rules, ...lighting } = current.responsibilities.lighting;
    stage = 'planning_unreachable';
    const response = await fetch(
      buildBackendUrlFromBase(
        buildBackendBaseUrlForMode(),
        '/internal/autonomy/plan',
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: withInternalBackendAuth({
          'Content-Type': 'application/json',
          'x-user-id': session.username,
        }),
        body: JSON.stringify({
          instructions,
          context: {
            settings: {
              ...current.responsibilities,
              automations: {
                enabled: current.responsibilities.automations.enabled,
                rules: current.responsibilities.automations.rules.map(
                  ({ id, title, enabled }) => ({ id, title, enabled }),
                ),
              },
              lighting: {
                ...lighting,
                rules: rules.map(({ id, title, team, scene, enabled }) => ({
                  id,
                  title,
                  team,
                  scene,
                  enabled,
                })),
              },
            },
            schema: contract.schema,
          },
        }),
      },
    );
    upstreamStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      throw planningHttpFailure(response.status);
    }
    stage = 'invalid_response';
    if (!response.body) throw new PlanningFailure('invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 64 * 1024) throw new PlanningFailure('oversized_response');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const choice = result?.choices?.[0];
    const reason = choice?.message?.refusal;
    if (
      choice?.finish_reason === 'content_filter' ||
      (typeof reason === 'string' && reason.trim())
    ) {
      return res.status(200).json({
        type: 'unsupported',
        message:
          typeof reason === 'string' && reason.trim() && reason.length <= 400
            ? `The planning model declined this request: ${reason.trim()}`
            : 'The planning model blocked this request under its content policy. Review the requested task before submitting another preview.',
      });
    }
    if (choice?.finish_reason === 'length')
      throw new PlanningFailure('incomplete_response');
    if (
      choice?.finish_reason !== 'stop' ||
      typeof choice.message?.content !== 'string' ||
      choice.message?.tool_calls?.length
    )
      throw new Error('Incomplete planning response');
    const candidate = JSON.parse(choice.message.content);
    stage = 'capabilities_unavailable';
    upstreamStatus = undefined;
    const available =
      candidate?.type === 'automation'
        ? await capabilities(session.username, controller.signal)
        : [];
    stage = 'invalid_plan';
    const plan = parseAutomationPlan(
      candidate,
      current,
      instructions,
      available,
    );
    return res.status(200).json(plan);
  } catch (error) {
    return fail(timedOut ? new PlanningFailure('planning_timeout') : error);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    res.off('close', onClose);
  }
}
