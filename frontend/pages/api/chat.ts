import { Logger } from '@/utils/logger';

const logger = new Logger('ChatAPILegacy');

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  logger.error('legacy /api/chat called; this route has been retired in favor of /api/chat/async', {
    method: req.method,
    referer: req.headers.get('referer') ?? null,
    userAgent: req.headers.get('user-agent') ?? null,
  });

  return new Response(
    JSON.stringify({
      error: 'Gone',
      message: '/api/chat has been retired. Use /api/chat/async.',
    }),
    {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
