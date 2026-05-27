'use client';

import { IconAlertTriangle, IconExternalLink } from '@tabler/icons-react';
import { useState } from 'react';

import { Button } from '@/components/primitives';
import type { AutonomyApproval } from '@/types/autonomy';

interface ApprovalBannerProps {
  approvals: AutonomyApproval[];
  busyId: string | null;
  onResolve: (id: string, decision: 'approved' | 'denied') => void;
}

const COLLAPSED_LIMIT = 2;

export function ApprovalBanner({ approvals, busyId, onResolve }: ApprovalBannerProps) {
  const [expanded, setExpanded] = useState(false);
  if (!approvals.length) return null;

  const overflow = approvals.length - COLLAPSED_LIMIT;
  const visible = expanded ? approvals : approvals.slice(0, COLLAPSED_LIMIT);

  return (
    <section
      role="region"
      aria-label={`${approvals.length} pending approval${approvals.length === 1 ? '' : 's'}`}
      aria-live="assertive"
      className="mx-auto mb-8 w-full max-w-[720px] space-y-2 px-1"
    >
      <div className="flex items-baseline gap-3 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-200/80">
        <span aria-hidden className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
        <span>waiting on you · {approvals.length}</span>
      </div>
      {visible.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          busy={busyId === approval.id}
          onResolve={onResolve}
        />
      ))}
      {overflow > 0 && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block w-full rounded-md border border-amber-400/15 bg-amber-400/[0.04] px-3 py-2 text-left font-mono text-[11px] uppercase tracking-wide text-amber-200/80 transition hover:bg-amber-400/[0.07]"
        >
          + {overflow} more pending
        </button>
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  busy,
  onResolve,
}: {
  approval: AutonomyApproval;
  busy: boolean;
  onResolve: (id: string, decision: 'approved' | 'denied') => void;
}) {
  return (
    <article className="rounded-md border-l-2 border-amber-400/70 bg-amber-400/[0.05] px-4 py-3">
      <div className="flex items-start gap-3">
        <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] font-semibold leading-snug text-amber-50">
            {approval.action}
          </p>
          {approval.reason && (
            <p className="mt-1 font-serif text-[14px] leading-[1.6] text-amber-100/80">
              {approval.reason}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {approval.authUrl && (
              <Button
                size="xs"
                variant="secondary"
                onClick={() => window.open(approval.authUrl, '_blank', 'noopener,noreferrer')}
                leftIcon={<IconExternalLink size={12} />}
              >
                Open auth
              </Button>
            )}
            <Button
              size="xs"
              variant="success"
              isLoading={busy}
              onClick={() => onResolve(approval.id, 'approved')}
            >
              {approval.actionType === 'oauth_authorization' ? 'Continue' : 'Approve'}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onResolve(approval.id, 'denied')}
            >
              Deny
            </Button>
            {approval.risk && approval.risk !== 'low' && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-amber-200/70">
                risk · {approval.risk}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
