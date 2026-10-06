import { updateJsonAtomically } from '@/server/atomicJson';
import { jsonGet, sessionKey } from '@/server/session/redis';

type Kind = 'chat' | 'image';
interface Submission {
  jobId?: string;
  cancelled: boolean;
}
const TTL_SECONDS = 3600;

export function validSubmissionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function key(kind: Kind, user: string, id: string): string {
  return sessionKey(['job-submission', kind, user, id]);
}

// The browser knows this identifier before POST is sent. A user-scoped stop
// tombstone can therefore win even before the server allocates the job.
export async function registerSubmission(
  kind: Kind,
  user: string,
  id: string,
  jobId: string,
): Promise<Submission> {
  return (await updateJsonAtomically<Submission>(
    key(kind, user, id),
    (current) => {
      if (current?.jobId) throw new Error('Submission already exists');
      return { jobId, cancelled: current?.cancelled ?? false };
    },
    TTL_SECONDS,
  ))!;
}

export async function cancelSubmission(
  kind: Kind,
  user: string,
  id: string,
): Promise<Submission> {
  return (await updateJsonAtomically<Submission>(
    key(kind, user, id),
    (current) => ({
      ...current,
      cancelled: true,
    }),
    TTL_SECONDS,
  ))!;
}

export async function submissionCancelled(
  kind: Kind,
  user: string,
  id?: string,
): Promise<boolean> {
  if (!id) return false;
  return Boolean((await jsonGet(key(kind, user, id)))?.cancelled);
}
