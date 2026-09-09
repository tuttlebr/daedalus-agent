'use client';

import {
  IconBrandGoogle,
  IconCheck,
  IconRefresh,
  IconShieldLock,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';

import { apiDelete, apiGet } from '@/utils/app/api';
import type { GoogleWorkspaceConnection } from '@/utils/app/googleWorkspace';

import { Button, Badge } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

import { useUISettingsStore } from '@/state/uiSettingsStore';

type ConnectionsResponse = { connections: GoogleWorkspaceConnection[] };
type ResetResponse = ConnectionsResponse & {
  reset: {
    service: GoogleWorkspaceConnection['id'];
    authorizationCleared: true;
  };
};

export function ConnectionsView() {
  const setActiveView = useUISettingsStore((state) => state.setActiveView);
  const [connections, setConnections] = useState<GoogleWorkspaceConnection[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resettingService, setResettingService] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet<ConnectionsResponse>(
        '/api/google-workspace/connections',
      );
      setConnections(response.connections);
    } catch {
      setError('Connection status is temporarily unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reconnect = useCallback(
    async (connection: GoogleWorkspaceConnection) => {
      if (
        !window.confirm(
          `Reconnect ${connection.label}? This clears its saved authorization and cached connection. Other Workspace services are not affected.`,
        )
      ) {
        return;
      }
      setResettingService(connection.id);
      setError(null);
      setNotice(null);
      try {
        const response = await apiDelete<ResetResponse>(
          `/api/google-workspace/connections?service=${connection.id}`,
        );
        setConnections(response.connections);
        setNotice(
          `${connection.label} authorization cleared. Go to Chat and retry the request to start a fresh Google sign-in.`,
        );
      } catch (resetError) {
        const body = (resetError as { body?: { error?: unknown } })?.body;
        setError(
          typeof body?.error === 'string'
            ? body.error
            : `Could not reconnect ${connection.label}. Please try again.`,
        );
      } finally {
        setResettingService(null);
      }
    },
    [],
  );

  const savedCount = connections.filter(
    (connection) => connection.authorizationSaved,
  ).length;

  return (
    <section className="app-page h-full overflow-y-auto bg-app px-4 pb-8 md:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-xl bg-nvidia-green/15 p-2 text-nvidia-green">
              <IconBrandGoogle size={24} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1 basis-48">
              <h1 className="break-words text-2xl font-semibold text-dark-text-primary">
                Google Workspace
              </h1>
              <p className="text-sm text-dark-text-muted">
                Manage the Google services available in your chats.
              </p>
            </div>
          </div>
        </header>

        <GlassCard variant="subtle" className="flex gap-3">
          <IconShieldLock
            size={20}
            className="mt-0.5 flex-shrink-0 text-nvidia-blue"
            aria-hidden="true"
          />
          <div className="space-y-1 text-sm text-dark-text-secondary">
            <p className="font-medium text-dark-text-primary">
              You choose which services Daedalus can access.
            </p>
            <p>
              The first time you use each service, Google asks you to approve
              access. Your authorization is saved securely for future chats.
              Reconnect a service to sign in again, or manage access in your
              Google Account.
            </p>
          </div>
        </GlassCard>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-dark-text-muted" aria-live="polite">
            {loading
              ? 'Checking saved authorizations…'
              : error
              ? 'Connection status unavailable'
              : `${savedCount} of ${connections.length} services have saved authorization`}
          </p>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<IconRefresh size={16} />}
            isLoading={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-nvidia-red/30 bg-nvidia-red/10 px-4 py-3 text-sm text-nvidia-red"
          >
            {error}
          </p>
        )}

        {notice && (
          <p
            role="status"
            className="rounded-lg border border-nvidia-green/30 bg-nvidia-green/10 px-4 py-3 text-sm text-dark-text-primary"
          >
            {notice}
          </p>
        )}

        {!loading && !error && connections.length === 0 && (
          <GlassCard>
            <p className="text-sm text-muted">
              No Google services are available yet. Use Refresh to check again.
            </p>
          </GlassCard>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {connections.map((connection) => (
            <GlassCard key={connection.id} className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="font-medium text-dark-text-primary">
                  {connection.label}
                </h2>
                <Badge
                  className="max-w-full"
                  variant={
                    connection.authorizationSaved ? 'success' : 'secondary'
                  }
                  icon={
                    connection.authorizationSaved ? (
                      <IconCheck size={13} />
                    ) : undefined
                  }
                >
                  <span className="min-w-0 whitespace-normal break-words">
                    {connection.authorizationSaved
                      ? 'Saved, unverified'
                      : 'No saved authorization'}
                  </span>
                </Badge>
              </div>
              <p className="text-sm text-dark-text-muted">
                {connection.description}
              </p>
              <div className="flex flex-wrap gap-2">
                {!connection.authorizationSaved && (
                  <Button
                    className="min-w-0 max-w-full"
                    variant="accent"
                    size="sm"
                    onClick={() => setActiveView('chat')}
                  >
                    <span className="min-w-0 break-words">Connect in Chat</span>
                  </Button>
                )}
                <Button
                  className="min-w-0 max-w-full"
                  aria-label={`${
                    connection.authorizationSaved ? 'Reconnect' : 'Start fresh'
                  } ${connection.label}`}
                  variant="secondary"
                  size="sm"
                  leftIcon={<IconRefresh size={16} />}
                  isLoading={resettingService === connection.id}
                  disabled={
                    resettingService !== null &&
                    resettingService !== connection.id
                  }
                  onClick={() => void reconnect(connection)}
                >
                  <span className="min-w-0 break-words">
                    {connection.authorizationSaved
                      ? 'Reconnect'
                      : 'Start fresh'}
                  </span>
                </Button>
              </div>
            </GlassCard>
          ))}
        </div>

        <GlassCard variant="subtle" className="space-y-3">
          <p className="text-sm text-dark-text-secondary">
            To connect a service, ask Daedalus to use it in Chat and follow the
            Google authorization prompt. A saved record does not mean Google
            will still accept it. If a service cannot use its saved
            authorization, choose Reconnect above, then retry the request in
            Chat.
          </p>
          <Button variant="accent" onClick={() => setActiveView('chat')}>
            Go to Chat
          </Button>
        </GlassCard>
      </div>
    </section>
  );
}
