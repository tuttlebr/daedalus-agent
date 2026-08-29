'use client';

import {
  IconCheck,
  IconExternalLink,
  IconLoader2,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { McpApprovalMarker } from '@/utils/app/mcpApproval';

type ApprovalState =
  | 'checking'
  | 'pending'
  | 'submitting'
  | 'running'
  | 'oauth_required'
  | 'completed'
  | 'denied'
  | 'failed';

interface McpApprovalCardProps {
  approval: McpApprovalMarker;
  jobId?: string;
}

export function McpApprovalCard({ approval, jobId }: McpApprovalCardProps) {
  const [state, setState] = useState<ApprovalState>('checking');
  const [authUrl, setAuthUrl] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const decisionStarted = useRef(false);

  const readStatus = useCallback(async () => {
    const response = await fetch(
      `/api/mcp-approvals/${encodeURIComponent(approval.requestId)}`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (response.status === 404) {
      setState('pending');
      return;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Status check failed');
    setState(payload.status as ApprovalState);
    setAuthUrl(
      typeof payload.authUrl === 'string' ? payload.authUrl : undefined,
    );
    setError(typeof payload.error === 'string' ? payload.error : undefined);
  }, [approval.requestId]);

  useEffect(() => {
    void readStatus().catch(() => {});
  }, [readStatus]);

  useEffect(() => {
    if (!['running', 'oauth_required'].includes(state)) return;
    const timer = window.setInterval(() => {
      void readStatus().catch((statusError) => {
        setError(
          statusError instanceof Error
            ? statusError.message
            : 'Status check failed',
        );
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [readStatus, state]);

  const decide = async (decision: 'approved' | 'denied') => {
    if (decisionStarted.current) return;
    decisionStarted.current = true;
    setState('submitting');
    setError(undefined);
    try {
      const response = await fetch(
        `/api/mcp-approvals/${encodeURIComponent(approval.requestId)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, jobId }),
        },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Approval could not be resolved');
      }
      setState(payload.status as ApprovalState);
      if (typeof payload.authUrl === 'string') {
        setAuthUrl(payload.authUrl);
      }
    } catch (decisionError) {
      decisionStarted.current = false;
      setState('failed');
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : 'Approval could not be resolved',
      );
    }
  };

  const busy = ['checking', 'submitting', 'running'].includes(state);

  return (
    <div className="rounded-2xl rounded-tl-lg border border-nvidia-green/25 bg-dark-bg-secondary/90 px-4 py-4">
      <div className="flex items-start gap-3">
        <IconShieldCheck
          size={20}
          className="mt-0.5 flex-shrink-0 text-nvidia-green"
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-dark-text-primary">
            Approval required
          </div>
          <div className="mt-1 text-sm text-dark-text-secondary">
            {approval.summary}
          </div>
          <div className="mt-1 text-xs text-dark-text-muted">
            The exact action is locked to this request. Document content is not
            sent back through the model.
          </div>

          {error && (
            <div role="alert" className="mt-3 text-xs text-nvidia-red">
              {error}
            </div>
          )}

          {state === 'completed' && (
            <div className="mt-3 flex items-center gap-1.5 text-sm text-nvidia-green">
              <IconCheck size={16} /> Update completed
            </div>
          )}
          {state === 'denied' && (
            <div className="mt-3 flex items-center gap-1.5 text-sm text-dark-text-muted">
              <IconX size={16} /> Update denied; no action was taken
            </div>
          )}
          {busy && (
            <div
              role="status"
              className="mt-3 flex items-center gap-1.5 text-sm text-dark-text-muted"
            >
              <IconLoader2 size={16} className="animate-spin" />
              {state === 'checking'
                ? 'Loading approval…'
                : state === 'submitting'
                ? 'Starting update…'
                : 'Updating…'}
            </div>
          )}
          {state === 'oauth_required' && authUrl && (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-nvidia-green px-3 py-2 text-sm font-medium text-black hover:bg-nvidia-green-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/50"
            >
              Authorize Google Docs <IconExternalLink size={14} />
            </a>
          )}

          {state === 'pending' && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void decide('approved')}
                className="rounded-lg bg-nvidia-green px-4 py-2 text-sm font-medium text-black hover:bg-nvidia-green-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/50"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => void decide('denied')}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-dark-text-primary hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
