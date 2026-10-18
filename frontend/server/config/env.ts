export function positiveIntegerFromEnv(name: string, fallback: number): number {
  const parsed = Math.floor(Number(process.env[name]));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
