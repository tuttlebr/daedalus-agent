'use client';

import { IconCopy, IconKey, IconRefresh, IconTrash } from '@tabler/icons-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';

import { apiDelete, apiGet, apiPost } from '@/utils/app/api';

import { Button, Input } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

interface ApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface ApiKeyList {
  enabled: boolean;
  maxKeys: number;
  keys: ApiKeyMetadata[];
}

interface CreatedKey {
  key: string;
  metadata: ApiKeyMetadata;
}

function errorMessage(error: unknown, fallback: string): string {
  const body = (error as { body?: { error?: unknown } })?.body;
  return typeof body?.error === 'string' ? body.error : fallback;
}

function formatTime(value: number | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Never';
}

/**
 * The signed-in user's keys for the OpenAI/Anthropic compatible API. A secret
 * is displayed once, right after creation or rotation.
 */
export function ApiKeysPanel() {
  const [state, setState] = useState<ApiKeyList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<ApiKeyList>('/api/api-keys');
      if (!list || !Array.isArray(list.keys)) {
        throw new Error('Unexpected API key listing');
      }
      setState(list);
      setError(null);
    } catch (loadError) {
      setError(
        errorMessage(loadError, 'API keys are temporarily unavailable.'),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reveal = (created: CreatedKey) => {
    setRevealed(created);
    setCopied(false);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('create');
    setError(null);
    try {
      reveal(
        await apiPost<{ name: string }, CreatedKey>('/api/api-keys', { name }),
      );
      setName('');
      await refresh();
    } catch (createError) {
      setError(errorMessage(createError, 'Could not create the key.'));
    } finally {
      setBusy(null);
    }
  };

  const rotate = async (key: ApiKeyMetadata) => {
    if (
      !window.confirm(
        `Rotate "${key.name}"? Apps using the current key stop working immediately.`,
      )
    )
      return;
    setBusy(key.id);
    setError(null);
    try {
      reveal(
        await apiPost<{ action: string }, CreatedKey>(
          `/api/api-keys/${key.id}`,
          { action: 'rotate' },
        ),
      );
      await refresh();
    } catch (rotateError) {
      setError(errorMessage(rotateError, 'Could not rotate the key.'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (key: ApiKeyMetadata) => {
    if (
      !window.confirm(
        `Revoke "${key.name}"? Apps using it stop working immediately.`,
      )
    )
      return;
    setBusy(key.id);
    setError(null);
    try {
      await apiDelete(`/api/api-keys/${key.id}`);
      if (revealed?.metadata.id === key.id) setRevealed(null);
      await refresh();
    } catch (revokeError) {
      setError(errorMessage(revokeError, 'Could not revoke the key.'));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const atLimit = Boolean(state && state.keys.length >= state.maxKeys);

  return (
    <section aria-labelledby="api-keys-heading" className="space-y-4">
      <div className="space-y-1">
        <h2
          id="api-keys-heading"
          className="flex items-center gap-2 text-lg font-semibold text-dark-text-primary"
        >
          <IconKey size={20} aria-hidden="true" />
          API access
        </h2>
        <p className="text-sm text-dark-text-secondary">
          Use Daedalus from apps that speak the OpenAI Chat Completions or
          Anthropic Messages API. Requests run as you, with your tools, memory
          and connected services. Approvals and Google sign-in still happen here
          in the web app.
        </p>
      </div>

      <GlassCard variant="subtle" className="space-y-1 text-sm">
        <p className="text-dark-text-secondary">
          OpenAI base URL:{' '}
          <code className="break-all text-dark-text-primary">{origin}/v1</code>
        </p>
        <p className="text-dark-text-secondary">
          Anthropic base URL:{' '}
          <code className="break-all text-dark-text-primary">{origin}</code>
        </p>
        <p className="text-dark-text-secondary">
          Model: <code className="text-dark-text-primary">daedalus</code>
        </p>
      </GlassCard>

      {state && !state.enabled && (
        <p
          role="status"
          className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-dark-text-primary"
        >
          API access is turned off on this server. Keys you create now work once
          an administrator enables it.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-error bg-error/10 px-4 py-3 text-sm text-primary"
        >
          {error}
        </p>
      )}

      {revealed && (
        <GlassCard className="space-y-3" role="status" aria-live="polite">
          <p className="text-sm font-medium text-dark-text-primary">
            Copy the key for “{revealed.metadata.name}” now. It is not shown
            again.
          </p>
          <code
            className="block select-all break-all rounded-lg bg-black/30 px-3 py-2 text-sm text-dark-text-primary"
            data-testid="api-key-secret"
          >
            {revealed.key}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="accent"
              leftIcon={<IconCopy size={16} />}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy key'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRevealed(null)}
            >
              Done
            </Button>
          </div>
        </GlassCard>
      )}

      <form
        onSubmit={(event) => void create(event)}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="min-w-0 flex-1 space-y-1 text-sm text-dark-text-secondary">
          <span>New key name</span>
          <Input
            value={name}
            maxLength={64}
            placeholder="For example, Laptop editor"
            onChange={(event) => setName(event.target.value)}
            disabled={atLimit}
          />
        </label>
        <Button
          type="submit"
          variant="accent"
          isLoading={busy === 'create'}
          disabled={!name.trim() || atLimit || busy !== null}
        >
          Create key
        </Button>
      </form>
      {atLimit && (
        <p className="text-sm text-dark-text-muted">
          You have the maximum of {state?.maxKeys} keys. Revoke one to create
          another.
        </p>
      )}

      {loading && !state ? (
        <p className="text-sm text-dark-text-muted">Loading keys…</p>
      ) : state && state.keys.length === 0 ? (
        <p className="text-sm text-dark-text-muted">No API keys yet.</p>
      ) : (
        <ul className="space-y-2" aria-label="API keys">
          {state?.keys.map((key) => (
            <li key={key.id}>
              <GlassCard className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="break-words font-medium text-dark-text-primary">
                    {key.name}
                  </p>
                  <p className="text-xs text-dark-text-muted">
                    <code>{key.prefix}…</code> · Created{' '}
                    {formatTime(key.createdAt)} · Last used{' '}
                    {formatTime(key.lastUsedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<IconRefresh size={16} />}
                    aria-label={`Rotate ${key.name}`}
                    isLoading={busy === key.id}
                    disabled={busy !== null}
                    onClick={() => void rotate(key)}
                  >
                    Rotate
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    leftIcon={<IconTrash size={16} />}
                    aria-label={`Revoke ${key.name}`}
                    disabled={busy !== null}
                    onClick={() => void revoke(key)}
                  >
                    Revoke
                  </Button>
                </div>
              </GlassCard>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
