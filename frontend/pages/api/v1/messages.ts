import type { NextApiRequest, NextApiResponse } from 'next';

import {
  parseAnthropicMessagesRequest,
  validateAnthropicHeaders,
} from '@/server/compat/anthropicRequest';
import { handleCompatChat } from '@/server/compat/execution';
import { createAnthropicResponder } from '@/server/compat/responders';

export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
};

/** Anthropic Messages compatible entry to the Daedalus agent. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleCompatChat(req, res, {
    protocol: 'anthropic',
    name: 'messages',
    validateHeaders: validateAnthropicHeaders,
    parse: parseAnthropicMessagesRequest,
    createResponder: createAnthropicResponder,
  });
}
