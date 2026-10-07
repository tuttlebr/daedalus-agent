'use client';

import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconLoader2,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  requiresAdditionalMcpConfirmation,
  type McpApprovalMarker,
} from '@/utils/app/mcpApproval';

import type { McpApprovalPreview } from '@/server/chat/mcpApproval';

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
  const [details, setDetails] = useState<McpApprovalPreview | undefined>();
  const [confirmingHighImpact, setConfirmingHighImpact] = useState(false);
  const decisionStarted = useRef(false);
  const requiresAdditionalConfirmation =
    requiresAdditionalMcpConfirmation(approval);

  const readStatus = useCallback(async () => {
    const response = await fetch(
      `/api/mcp-approvals/${encodeURIComponent(approval.requestId)}`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (response.status === 404) {
      setState('failed');
      setError('This approval request is missing or has expired.');
      return;
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Status check failed');
    setState(payload.status as ApprovalState);
    setAuthUrl(
      typeof payload.authUrl === 'string' ? payload.authUrl : undefined,
    );
    setError(typeof payload.error === 'string' ? payload.error : undefined);
    if (payload.approval && typeof payload.approval === 'object') {
      setDetails(payload.approval as McpApprovalPreview);
    }
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
    if (
      decision === 'approved' &&
      requiresAdditionalConfirmation &&
      !confirmingHighImpact
    ) {
      setConfirmingHighImpact(true);
      return;
    }
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
            The exact action and argument hash are locked to this request.
            Credentials and sensitive free text are redacted below.
          </div>

          {details && (
            <div className="mt-3 rounded-lg border border-separator/70 bg-fill/[0.04] p-3 text-xs text-dark-text-secondary">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-dark-text-muted">Server</dt>
                <dd className="break-all font-mono">{details.serverName}</dd>
                <dt className="text-dark-text-muted">Tool</dt>
                <dd className="break-all font-mono">{details.toolName}</dd>
                <dt className="text-dark-text-muted">Target</dt>
                <dd className="break-all">{details.target}</dd>
                <dt className="text-dark-text-muted">Argument hash</dt>
                <dd className="break-all font-mono">
                  {details.argumentsSha256}
                </dd>
              </dl>
              <div className="mt-3 text-dark-text-muted">Arguments</div>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-dark-bg-primary/50 p-2 font-mono text-dark-text-primary">
                {JSON.stringify(details.arguments, null, 2)}
              </pre>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-3 text-xs text-primary">
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
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-action px-3 py-2 text-sm font-medium text-on-action hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Authorize Google Docs <IconExternalLink size={14} />
            </a>
          )}

          {state === 'pending' && (
            <div className="mt-4">
              {confirmingHighImpact && (
                <div
                  role="alert"
                  className="mb-3 flex items-start gap-2 rounded-lg border border-nvidia-yellow/40 bg-nvidia-yellow/10 p-3 text-xs text-dark-text-primary"
                >
                  <IconAlertTriangle
                    size={16}
                    className="mt-0.5 flex-shrink-0 text-nvidia-yellow"
                  />
                  This is a high-impact operation. Review the server, target,
                  and redacted arguments, then confirm once more.
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void decide('approved')}
                  className="rounded-lg bg-action px-4 py-2 text-sm font-medium text-on-action hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {confirmingHighImpact ? 'Confirm approval' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={() => void decide('denied')}
                  className="rounded-lg border border-separator/70 px-4 py-2 text-sm font-medium text-dark-text-primary hover:bg-fill/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-separator/70"
                >
                  Deny
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
