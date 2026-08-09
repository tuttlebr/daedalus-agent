'use client';

import {
  IconBrandGoogle,
  IconCheck,
  IconRefresh,
  IconShieldLock,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';

import { apiGet } from '@/utils/app/api';
import type { GoogleWorkspaceConnection } from '@/utils/app/googleWorkspace';

import { Button, Badge } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

import { useUISettingsStore } from '@/state/uiSettingsStore';

type ConnectionsResponse = { connections: GoogleWorkspaceConnection[] };

export function ConnectionsView() {
  const setActiveView = useUISettingsStore((state) => state.setActiveView);
  const [connections, setConnections] = useState<GoogleWorkspaceConnection[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const savedCount = connections.filter(
    (connection) => connection.authorizationSaved,
  ).length;

  return (
    <section className="h-full overflow-y-auto bg-dark-bg-primary px-4 py-8 md:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-nvidia-green/15 p-2 text-nvidia-green">
              <IconBrandGoogle size={24} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold text-dark-text-primary">
                Google Workspace
              </h1>
              <p className="text-sm text-dark-text-muted">
                Review saved Google authorization records shared across your
                chats.
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
              Authorize once per Workspace service, not once per chat.
            </p>
            <p>
              Google exposes these as separate MCP resources, so the first use
              of each service can still open its own consent flow. Saved tokens
              remain in the server-side object store and are checked only when
              the service is used. This page never retrieves their contents.
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

        <div className="grid gap-3 md:grid-cols-2">
          {connections.map((connection) => (
            <GlassCard key={connection.id} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-medium text-dark-text-primary">
                  {connection.label}
                </h2>
                <Badge
                  variant={
                    connection.authorizationSaved ? 'success' : 'secondary'
                  }
                  icon={
                    connection.authorizationSaved ? (
                      <IconCheck size={13} />
                    ) : undefined
                  }
                >
                  {connection.authorizationSaved
                    ? 'Saved, unverified'
                    : 'No saved authorization'}
                </Badge>
              </div>
              <p className="text-sm text-dark-text-muted">
                {connection.description}
              </p>
            </GlassCard>
          ))}
        </div>

        <GlassCard variant="subtle" className="space-y-3">
          <p className="text-sm text-dark-text-secondary">
            To connect a service, ask Daedalus to use it in Chat and follow the
            Google authorization prompt. A saved record does not mean Google
            will still accept it. When a service rejects saved authorization,
            Daedalus starts a new prompt automatically.
          </p>
          <Button variant="accent" onClick={() => setActiveView('chat')}>
            Go to Chat
          </Button>
        </GlassCard>
      </div>
    </section>
  );
}
