import type { NextApiRequest, NextApiResponse } from 'next';

import { handleCompatChat } from '@/server/compat/execution';
import { createResponsesResponder } from '@/server/compat/responders';
import { parseResponsesRequest } from '@/server/compat/responsesRequest';

export const config = {
  api: { bodyParser: false, responseLimit: false, externalResolver: true },
};

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleCompatChat(req, res, {
    protocol: 'openai',
    name: 'responses',
    parse: parseResponsesRequest,
    createResponder: createResponsesResponder,
  });
}
