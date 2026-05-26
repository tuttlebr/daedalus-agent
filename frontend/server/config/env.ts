export function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function stringFromEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}
