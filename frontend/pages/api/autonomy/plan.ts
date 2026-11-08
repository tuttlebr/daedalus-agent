import type { NextApiRequest, NextApiResponse } from 'next';

import {
  buildBackendBaseUrlForMode,
  buildBackendUrlFromBase,
} from '@/utils/app/backendApi';
import { withInternalBackendAuth } from '@/utils/server/backendAuth';

import contract from '@/server/autonomy/contract.json';
import { parseAutomationPlan } from '@/server/autonomy/planning';
import { getConfig, saveAutomationPlan } from '@/server/autonomy/store';
import { enforceRateLimit, ruleFromEnv } from '@/server/rateLimit';
import { requireAuthenticatedUser } from '@/server/session/_utils';

export const config = { api: { bodyParser: { sizeLimit: '32kb' } } };
const limit = ruleFromEnv('autonomy-plan', 'RATE_LIMIT_AUTONOMY_PLAN', 10, 60);
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
  if (req.method === 'PUT') {
    try {
      return res
        .status(200)
        .json(await saveAutomationPlan(session.username, req.body));
    } catch {
      return res.status(400).json({
        error: 'Could not save this plan. Preview your instructions again.',
      });
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
  const timeout = setTimeout(() => controller.abort(), 120_000);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);
  try {
    const current = await getConfig(session.username);
    const { rules, ...lighting } = current.responsibilities.lighting;
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
    if (!response.ok || !response.body) throw new Error('Planning unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 64 * 1024) throw new Error('Oversized planning response');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const choice = result.choices?.[0];
    if (
      choice?.finish_reason !== 'stop' ||
      typeof choice.message?.content !== 'string' ||
      choice.message?.tool_calls?.length
    )
      throw new Error('Incomplete planning response');
    return res
      .status(200)
      .json(
        parseAutomationPlan(
          JSON.parse(choice.message.content),
          current,
          instructions,
        ),
      );
  } catch {
    if (!res.destroyed)
      return res.status(502).json({
        error:
          'Could not prepare the automation. Your instructions are still here; try again.',
      });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    res.off('close', onClose);
  }
}
