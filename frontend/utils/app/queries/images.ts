import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './keys';
import type { HistoryEntry } from '@/state/imagePanelStore';

async function fetchImageHistory(): Promise<HistoryEntry[]> {
  const res = await fetch('/api/images/history', { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { history?: HistoryEntry[] };
  return Array.isArray(data.history) ? data.history : [];
}

export function useImageHistory() {
  return useQuery({
    queryKey: queryKeys.images.history,
    queryFn: fetchImageHistory,
    staleTime: 60 * 1000,
  });
}

export function useInvalidateImageHistory() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: queryKeys.images.history });
}
