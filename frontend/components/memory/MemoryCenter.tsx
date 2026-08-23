'use client';

import {
  IconAlertTriangle,
  IconBrain,
  IconCheck,
  IconDatabase,
  IconEdit,
  IconFileText,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { FormEvent, useCallback, useEffect, useState } from 'react';

import { Badge, Button } from '@/components/primitives';
import { GlassCard } from '@/components/surfaces';

type MemoryFact = {
  id: string;
  text: string;
  type?: 'world' | 'experience' | 'observation' | string;
  state?: string;
  context?: string;
  date?: string;
  mentioned_at?: string;
  created_at?: string;
  tags?: string[];
};

type MemorySource = {
  id: string;
  created_at?: string;
  updated_at?: string;
  memory_unit_count?: number;
  text_length?: number;
  tags?: string[];
};

type MemorySourceDetail = MemorySource & {
  original_text?: string | null;
  document_metadata?: Record<string, unknown> | null;
};

type KnowledgePage = {
  id: string;
  name: string;
  description?: string;
  timestamp?: string;
  is_stale?: boolean;
  body?: string | null;
  markdown?: string;
};

type RetentionStatus = {
  total: number;
  counts: {
    accepted?: number;
    pending?: number;
    processing?: number;
    completed?: number;
    zero_fact?: number;
    failed?: number;
    timed_out?: number;
  };
};

type Page<T> = { items: T[]; total: number; limit: number; offset: number };

const PAGE_SIZE = 25;
const CLEAR_CONFIRMATION = 'DELETE ALL MY MEMORIES';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.detail === 'string'
        ? body.detail
        : 'Memory request failed.',
    );
  }
  return body as T;
}

function when(value?: string) {
  if (!value) return 'Date unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? 'Date unavailable'
    : parsed.toLocaleString();
}

export function MemoryCenter() {
  const [tab, setTab] = useState<'pages' | 'memories' | 'sources'>('pages');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [memoryType, setMemoryType] = useState('');
  const [offset, setOffset] = useState(0);
  const [memories, setMemories] = useState<Page<MemoryFact>>({
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [sources, setSources] = useState<Page<MemorySource>>({
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [pages, setPages] = useState<Page<KnowledgePage>>({
    items: [],
    total: 0,
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [retentionStatus, setRetentionStatus] =
    useState<RetentionStatus | null>(null);
  const [selectedPage, setSelectedPage] = useState<KnowledgePage | null>(null);
  const [selectedSource, setSelectedSource] =
    useState<MemorySourceDetail | null>(null);
  const [editing, setEditing] = useState<MemoryFact | null>(null);
  const [editText, setEditText] = useState('');
  const [clearText, setClearText] = useState('');
  const [showClear, setShowClear] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (submittedQuery) params.set('q', submittedQuery);
      if (tab === 'memories' && memoryType) {
        params.set('memory_type', memoryType);
      }
      const statusRequest = requestJson<RetentionStatus>('/api/memory/status')
        .then(setRetentionStatus)
        .catch(() => setRetentionStatus(null));
      if (tab === 'pages') {
        const response = await requestJson<{
          items: KnowledgePage[];
          total: number;
        }>('/api/memory/pages');
        const normalizedQuery = submittedQuery.toLocaleLowerCase();
        const matching = normalizedQuery
          ? response.items.filter((page) =>
              `${page.name} ${page.description || ''}`
                .toLocaleLowerCase()
                .includes(normalizedQuery),
            )
          : response.items;
        setPages({
          items: matching.slice(offset, offset + PAGE_SIZE),
          total: matching.length,
          limit: PAGE_SIZE,
          offset,
        });
      } else if (tab === 'memories') {
        setMemories(
          await requestJson<Page<MemoryFact>>(
            `/api/memory/memories?${params.toString()}`,
          ),
        );
      } else {
        setSources(
          await requestJson<Page<MemorySource>>(
            `/api/memory/sources?${params.toString()}`,
          ),
        );
      }
      await statusRequest;
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Memory is temporarily unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [memoryType, offset, submittedQuery, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSubmittedQuery(query.trim());
  };

  const editMemory = async () => {
    if (!editing || !editText.trim()) return;
    setWorkingId(editing.id);
    setError(null);
    try {
      await requestJson(
        `/api/memory/memories/${encodeURIComponent(editing.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: editText.trim() }),
        },
      );
      setEditing(null);
      setNotice(
        'Memory updated. Derived observations will refresh in the background.',
      );
      await refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Update failed.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const invalidateMemory = async (memory: MemoryFact) => {
    if (
      !window.confirm(
        'Forget this memory? It will be excluded from future recall.',
      )
    ) {
      return;
    }
    setWorkingId(memory.id);
    setError(null);
    try {
      await requestJson(
        `/api/memory/memories/${encodeURIComponent(memory.id)}/invalidate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: 'user requested forget in Memory Center',
          }),
        },
      );
      setNotice('Memory forgotten and removed from future recall.');
      await refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Forget failed.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const openSource = async (source: MemorySource) => {
    setWorkingId(source.id);
    setError(null);
    try {
      setSelectedSource(
        await requestJson<MemorySourceDetail>(
          `/api/memory/sources/${encodeURIComponent(source.id)}`,
        ),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Source failed to load.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const openPage = async (page: KnowledgePage) => {
    setWorkingId(page.id);
    setError(null);
    try {
      setSelectedPage(
        await requestJson<KnowledgePage>(
          `/api/memory/pages/${encodeURIComponent(page.id)}`,
        ),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Knowledge Page failed to load.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const deleteSource = async (sourceId: string) => {
    if (
      !window.confirm('Delete this source and every memory extracted from it?')
    )
      return;
    setWorkingId(sourceId);
    setError(null);
    try {
      await requestJson(`/api/memory/sources/${encodeURIComponent(sourceId)}`, {
        method: 'DELETE',
      });
      setSelectedSource(null);
      setNotice('Source and its extracted memories were deleted.');
      await refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Delete failed.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const clearAll = async () => {
    if (clearText !== CLEAR_CONFIRMATION) return;
    setWorkingId('clear-all');
    setError(null);
    try {
      await requestJson('/api/memory/memories/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: clearText }),
      });
      setShowClear(false);
      setClearText('');
      setSelectedPage(null);
      setSelectedSource(null);
      setNotice('All Hindsight memories were cleared.');
      await refresh();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : 'Clear failed.',
      );
    } finally {
      setWorkingId(null);
    }
  };

  const page =
    tab === 'pages' ? pages : tab === 'memories' ? memories : sources;
  const canPrevious = offset > 0;
  const canNext = offset + PAGE_SIZE < page.total;

  return (
    <section className="h-full overflow-y-auto bg-dark-bg-primary px-4 py-8 md:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-nvidia-green/15 p-2 text-nvidia-green">
              <IconBrain size={24} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold text-dark-text-primary">
                Memory Center
              </h1>
              <p className="max-w-2xl text-sm text-dark-text-muted">
                Review the durable facts Daedalus can recall and the user text
                they came from. Automatic memory applies to every authenticated
                chat.
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<IconRefresh size={16} />}
            isLoading={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
        </header>

        <GlassCard
          variant="subtle"
          className="flex gap-3 text-sm text-dark-text-secondary"
        >
          <IconDatabase
            className="mt-0.5 flex-shrink-0 text-nvidia-blue"
            size={19}
          />
          <p>
            Daedalus starts a conversation with a bounded memory brief, searches
            auto-refreshing Knowledge Pages during the conversation, and retains
            a sanitized, role-labelled user request and final answer afterward.
            Raw tool traces are never retained automatically.
          </p>
        </GlassCard>

        {retentionStatus && (
          <GlassCard variant="subtle" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-dark-text-primary">
                Automatic retention health
              </p>
              <span className="text-xs text-dark-text-muted">
                Last {retentionStatus.total} operations
              </span>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">
                Completed {retentionStatus.counts.completed || 0}
              </Badge>
              <Badge variant="secondary">
                No durable facts {retentionStatus.counts.zero_fact || 0}
              </Badge>
              <Badge variant="secondary">
                Pending{' '}
                {(retentionStatus.counts.accepted || 0) +
                  (retentionStatus.counts.pending || 0) +
                  (retentionStatus.counts.processing || 0)}
              </Badge>
              {(retentionStatus.counts.failed || 0) +
                (retentionStatus.counts.timed_out || 0) >
                0 && (
                <Badge variant="warning">
                  Needs attention{' '}
                  {(retentionStatus.counts.failed || 0) +
                    (retentionStatus.counts.timed_out || 0)}
                </Badge>
              )}
            </div>
          </GlassCard>
        )}

        <div
          className="flex items-center gap-2 border-b border-white/[0.08]"
          role="tablist"
        >
          {(['pages', 'memories', 'sources'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              onClick={() => {
                setTab(item);
                setOffset(0);
                setSelectedPage(null);
                setSelectedSource(null);
              }}
              className={`border-b-2 px-4 py-3 text-sm font-medium capitalize transition-colors ${
                tab === item
                  ? 'border-nvidia-green text-nvidia-green'
                  : 'border-transparent text-dark-text-muted hover:text-dark-text-primary'
              }`}
            >
              {item === 'pages'
                ? 'Knowledge Pages'
                : item === 'memories'
                ? 'Advanced facts'
                : 'Sources'}
            </button>
          ))}
        </div>

        <form
          onSubmit={submitSearch}
          className="flex flex-wrap items-center gap-2"
        >
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search {tab}</span>
            <IconSearch
              size={17}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dark-text-muted"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                tab === 'pages'
                  ? 'Search Knowledge Pages'
                  : tab === 'memories'
                  ? 'Search remembered facts'
                  : 'Search source IDs'
              }
              className="min-h-touch-min w-full rounded-lg border border-white/[0.1] bg-black/20 py-2 pl-10 pr-3 text-sm text-dark-text-primary outline-none focus:border-nvidia-green/60"
            />
          </label>
          {tab === 'memories' && (
            <select
              value={memoryType}
              onChange={(event) => {
                setMemoryType(event.target.value);
                setOffset(0);
              }}
              aria-label="Memory type"
              className="min-h-touch-min rounded-lg border border-white/[0.1] bg-dark-bg-secondary px-3 text-sm text-dark-text-primary"
            >
              <option value="">All types</option>
              <option value="world">Facts</option>
              <option value="experience">Experiences</option>
              <option value="observation">Observations</option>
            </select>
          )}
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>

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
            className="flex items-center gap-2 rounded-lg border border-nvidia-green/30 bg-nvidia-green/10 px-4 py-3 text-sm text-nvidia-green"
          >
            <IconCheck size={16} /> {notice}
          </p>
        )}

        {!loading && page.items.length === 0 && !error && (
          <GlassCard className="py-10 text-center text-sm text-dark-text-muted">
            No {tab} match this view yet.
          </GlassCard>
        )}

        {tab === 'pages' ? (
          selectedPage ? (
            <GlassCard className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <h2 className="font-medium text-dark-text-primary">
                    {selectedPage.name}
                  </h2>
                  <p className="text-xs text-dark-text-muted">
                    Updated {when(selectedPage.timestamp)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Close Knowledge Page"
                  onClick={() => setSelectedPage(null)}
                  className="rounded-lg p-2 text-dark-text-muted hover:bg-white/[0.05]"
                >
                  <IconX size={18} />
                </button>
              </div>
              {selectedPage.description && (
                <p className="text-xs text-dark-text-muted">
                  {selectedPage.description}
                </p>
              )}
              <article className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.08] bg-black/20 p-4 text-sm text-dark-text-secondary">
                {selectedPage.body || 'This page is still generating.'}
              </article>
            </GlassCard>
          ) : (
            <div className="space-y-3">
              {pages.items.map((knowledgePage) => (
                <GlassCard key={knowledgePage.id} className="space-y-2">
                  <button
                    type="button"
                    onClick={() => void openPage(knowledgePage)}
                    className="flex w-full items-start justify-between gap-3 text-left"
                  >
                    <span className="flex min-w-0 items-start gap-3">
                      <IconFileText
                        className="mt-0.5 flex-shrink-0 text-nvidia-green"
                        size={19}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium text-dark-text-primary">
                          {knowledgePage.name}
                        </span>
                        <span className="mt-1 block text-xs text-dark-text-muted">
                          {knowledgePage.description}
                        </span>
                      </span>
                    </span>
                    <Badge
                      variant={knowledgePage.is_stale ? 'warning' : 'secondary'}
                    >
                      {knowledgePage.is_stale ? 'Refreshing' : 'Current'}
                    </Badge>
                  </button>
                </GlassCard>
              ))}
            </div>
          )
        ) : tab === 'memories' ? (
          <div className="space-y-3">
            {memories.items.map((memory) => (
              <GlassCard key={memory.id} className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{memory.type || 'fact'}</Badge>
                      {memory.state && memory.state !== 'valid' && (
                        <Badge variant="warning">{memory.state}</Badge>
                      )}
                      <span className="text-xs text-dark-text-muted">
                        {when(
                          memory.mentioned_at ||
                            memory.date ||
                            memory.created_at,
                        )}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-dark-text-primary">
                      {memory.text}
                    </p>
                    {memory.context && (
                      <p className="text-xs text-dark-text-muted">
                        {memory.context}
                      </p>
                    )}
                  </div>
                  {memory.type !== 'observation' && (
                    <div className="flex flex-shrink-0 gap-1">
                      <button
                        type="button"
                        aria-label="Edit memory"
                        className="rounded-lg p-2 text-dark-text-muted hover:bg-white/[0.05] hover:text-dark-text-primary"
                        onClick={() => {
                          setEditing(memory);
                          setEditText(memory.text);
                        }}
                      >
                        <IconEdit size={17} />
                      </button>
                      <button
                        type="button"
                        aria-label="Forget memory"
                        disabled={workingId === memory.id}
                        className="rounded-lg p-2 text-dark-text-muted hover:bg-nvidia-red/10 hover:text-nvidia-red disabled:opacity-50"
                        onClick={() => void invalidateMemory(memory)}
                      >
                        <IconTrash size={17} />
                      </button>
                    </div>
                  )}
                </div>
                {memory.tags && memory.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {memory.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-white/[0.05] px-2 py-1 text-[11px] text-dark-text-muted"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </GlassCard>
            ))}
          </div>
        ) : selectedSource ? (
          <GlassCard className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-dark-text-primary">
                  {selectedSource.id}
                </p>
                <p className="text-xs text-dark-text-muted">
                  {selectedSource.memory_unit_count || 0} extracted memories ·
                  updated {when(selectedSource.updated_at)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close source"
                onClick={() => setSelectedSource(null)}
                className="rounded-lg p-2 text-dark-text-muted hover:bg-white/[0.05]"
              >
                <IconX size={18} />
              </button>
            </div>
            <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.08] bg-black/20 p-4 font-sans text-sm text-dark-text-secondary">
              {selectedSource.original_text ||
                'Raw source text is unavailable.'}
            </pre>
            <Button
              variant="danger"
              size="sm"
              leftIcon={<IconTrash size={16} />}
              isLoading={workingId === selectedSource.id}
              onClick={() => void deleteSource(selectedSource.id)}
            >
              Delete source and memories
            </Button>
          </GlassCard>
        ) : (
          <div className="space-y-3">
            {sources.items.map((source) => (
              <GlassCard
                key={source.id}
                className="flex items-center justify-between gap-3"
              >
                <button
                  type="button"
                  onClick={() => void openSource(source)}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  <IconFileText
                    className="mt-0.5 flex-shrink-0 text-nvidia-blue"
                    size={19}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-dark-text-primary">
                      {source.id}
                    </span>
                    <span className="block text-xs text-dark-text-muted">
                      {source.memory_unit_count || 0} memories ·{' '}
                      {source.text_length || 0} characters ·{' '}
                      {when(source.updated_at)}
                    </span>
                  </span>
                </button>
                <IconSearch
                  size={17}
                  className="flex-shrink-0 text-dark-text-muted"
                />
              </GlassCard>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 text-sm text-dark-text-muted">
          <span>{page.total} total</span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!canPrevious}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canNext}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>

        <GlassCard
          variant="subtle"
          className="space-y-3 border border-nvidia-red/20"
        >
          <div className="flex items-start gap-3">
            <IconAlertTriangle
              size={19}
              className="mt-0.5 flex-shrink-0 text-nvidia-red"
            />
            <div className="space-y-1">
              <p className="font-medium text-dark-text-primary">
                Clear all memory
              </p>
              <p className="text-sm text-dark-text-muted">
                This removes every retained source and fact for your account. It
                does not delete chat history.
              </p>
            </div>
          </div>
          {!showClear ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowClear(true)}
            >
              Clear all memory
            </Button>
          ) : (
            <div className="space-y-2">
              <label className="block text-sm text-dark-text-secondary">
                Type{' '}
                <span className="font-mono text-dark-text-primary">
                  {CLEAR_CONFIRMATION}
                </span>{' '}
                to continue.
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  value={clearText}
                  onChange={(event) => setClearText(event.target.value)}
                  className="min-h-touch-min min-w-[260px] flex-1 rounded-lg border border-nvidia-red/30 bg-black/20 px-3 text-sm text-dark-text-primary outline-none"
                />
                <Button
                  variant="danger"
                  size="sm"
                  disabled={clearText !== CLEAR_CONFIRMATION}
                  isLoading={workingId === 'clear-all'}
                  onClick={() => void clearAll()}
                >
                  Confirm clear
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShowClear(false);
                    setClearText('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </GlassCard>
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Edit memory"
        >
          <GlassCard className="w-full max-w-xl space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-dark-text-primary">
                Edit memory
              </h2>
              <button
                type="button"
                aria-label="Close editor"
                onClick={() => setEditing(null)}
                className="rounded-lg p-2 text-dark-text-muted hover:bg-white/[0.05]"
              >
                <IconX size={18} />
              </button>
            </div>
            <textarea
              value={editText}
              onChange={(event) => setEditText(event.target.value)}
              rows={6}
              autoFocus
              className="w-full rounded-lg border border-white/[0.1] bg-black/20 p-3 text-sm text-dark-text-primary outline-none focus:border-nvidia-green/60"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button
                variant="accent"
                size="sm"
                isLoading={workingId === editing.id}
                disabled={!editText.trim()}
                onClick={() => void editMemory()}
              >
                Save memory
              </Button>
            </div>
          </GlassCard>
        </div>
      )}
    </section>
  );
}
