import { updateJsonAtomically } from '@/server/atomicJson';

export const IMAGE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 7;
export const MAX_HISTORY_ENTRIES = 50;

/** Both API submissions and completed image jobs use the same atomic append. */
export async function appendImageHistoryEntry<T extends { id: string }>(
  key: string,
  entry: T,
  validate?: () => Promise<void>,
): Promise<T[]> {
  return (await updateJsonAtomically<T[]>(
    key,
    async (current) => {
      await validate?.();
      const entries = Array.isArray(current) ? current : [];
      return [entry, ...entries.filter((item) => item?.id !== entry.id)].slice(
        0,
        MAX_HISTORY_ENTRIES,
      );
    },
    IMAGE_HISTORY_TTL_SECONDS,
  ))!;
}
