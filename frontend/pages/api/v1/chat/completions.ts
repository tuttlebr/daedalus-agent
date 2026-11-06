import type { NextApiRequest, NextApiResponse } from 'next';

import { handleCompatChat } from '@/server/compat/execution';
import { parseOpenAIChatRequest } from '@/server/compat/openaiRequest';
import { createOpenAIResponder } from '@/server/compat/responders';

// Bodies are read with a vendor-shaped size limit; streams can outlive the
// default response size warning, and the handler always settles the response.
export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
};

/** OpenAI Chat Completions compatible entry to the Daedalus agent. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleCompatChat(req, res, {
    protocol: 'openai',
    name: 'chat.completions',
    parse: parseOpenAIChatRequest,
    createResponder: createOpenAIResponder,
  });
}
