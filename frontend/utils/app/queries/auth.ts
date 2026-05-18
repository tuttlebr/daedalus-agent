import { useQuery } from '@tanstack/react-query';
import { queryKeys } from './keys';

export interface AuthMeUser {
  id: string;
  username: string;
  name: string;
}

interface AuthMeResponse {
  user: AuthMeUser;
}

async function fetchAuthMe(): Promise<AuthMeUser | null> {
  const res = await fetch('/api/auth/me', { credentials: 'include' });
  if (!res.ok) return null;
  const data = (await res.json()) as AuthMeResponse;
  return data.user ?? null;
}

export function useAuthMe(enabled: boolean = true) {
  return useQuery({
    queryKey: queryKeys.auth.me,
    queryFn: fetchAuthMe,
    enabled,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 0,
  });
}
