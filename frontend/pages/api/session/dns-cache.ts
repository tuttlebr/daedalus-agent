import dns from 'node:dns/promises';

interface CachedRecord {
  ip: string;
  resolvedAt: number;
}

const REFRESH_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = REFRESH_INTERVAL_MS * 2;

const cache = new Map<string, CachedRecord>();
const refreshTimers = new Map<string, NodeJS.Timeout>();

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}

async function resolveOnce(host: string): Promise<string | null> {
  try {
    const { address } = await dns.lookup(host, { family: 4 });
    cache.set(host, { ip: address, resolvedAt: Date.now() });
    return address;
  } catch {
    return null;
  }
}

export async function primeDns(host: string): Promise<string | null> {
  if (!host || isIpLiteral(host)) {
    return host || null;
  }

  const initial = await resolveOnce(host);

  if (!refreshTimers.has(host)) {
    const timer = setInterval(() => {
      void resolveOnce(host);
    }, REFRESH_INTERVAL_MS);
    timer.unref();
    refreshTimers.set(host, timer);
  }

  return initial;
}

export function getCachedIp(host: string): string | null {
  if (!host || isIpLiteral(host)) {
    return host || null;
  }
  const entry = cache.get(host);
  if (!entry) return null;
  if (Date.now() - entry.resolvedAt > STALE_THRESHOLD_MS) return null;
  return entry.ip;
}

export function shutdownDnsCache(): void {
  for (const timer of refreshTimers.values()) clearInterval(timer);
  refreshTimers.clear();
  cache.clear();
}
