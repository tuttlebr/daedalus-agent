'use client';

import { useRef, useState } from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import type { AutonomyConfig } from '@/types/autonomy';

// This validator is pure and shares the generated Python contract with the API.
import { applyConfigPatch } from '@/server/autonomy/config';

export const buttonClass =
  'inline-flex min-h-touch-min max-w-full items-center justify-center gap-2 whitespace-normal break-words rounded-xl border border-separator px-3 py-2 text-sm hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50';

export function AutonomyJson({
  config,
  busy,
  saving,
  onApply,
}: {
  config: AutonomyConfig;
  busy: boolean;
  saving: boolean;
  onApply: (patch: unknown) => Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const [draft, setDraft] = useState<{ name: string; patch: unknown } | null>(
    null,
  );
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { saveFile, fileSaveDialog } = useFileSave();

  async function read(file: File) {
    const current = ++selection.current;
    setDraft(null);
    setError('');
    setNotice('');
    setReading(true);
    try {
      if (file.size > 128 * 1024)
        throw new Error('Choose a JSON file smaller than 128 KB.');
      let patch: unknown;
      try {
        patch = JSON.parse(await file.text());
      } catch {
        throw new Error(
          'This file could not be read as JSON. Check its syntax and try again.',
        );
      }
      applyConfigPatch(config, patch);
      if (current === selection.current) setDraft({ name: file.name, patch });
    } catch (cause) {
      if (current === selection.current) setError((cause as Error).message);
    } finally {
      if (current === selection.current) setReading(false);
    }
  }

  function download() {
    try {
      const downloaded = saveFile(
        new Blob([JSON.stringify(config, null, 2) + '\n'], {
          type: 'application/json',
        }),
        'daedalus-automations.json',
      );
      setNotice(
        downloaded
          ? 'JSON download started. Edit it and upload your changes here.'
          : 'JSON ready to save.',
      );
    } catch {
      setError('Could not download JSON. Try again.');
    }
  }

  return (
    <details className="rounded-2xl border border-separator bg-panel p-4">
      <summary className="min-h-touch-min cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Automation JSON
      </summary>
      <p className="mb-4 text-sm text-dark-text-secondary">
        Download your settings, edit the JSON, then upload it. Fields you leave
        out stay unchanged.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClass}
          disabled={busy || reading}
          onClick={download}
        >
          Download JSON
        </button>
        <button
          className={buttonClass}
          disabled={busy || reading}
          onClick={() => input.current?.click()}
        >
          {reading ? 'Reading JSON…' : 'Upload JSON'}
        </button>
        <input
          ref={input}
          className="sr-only"
          tabIndex={-1}
          type="file"
          accept=".json,application/json"
          aria-label="Automation JSON file"
          disabled={busy || reading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void read(file);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm">
          {notice}
        </p>
      )}
      {fileSaveDialog}
      {draft && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium">Ready to apply: {draft.name}</p>
          <p className="text-sm text-dark-text-secondary">
            Enabled automations start when you apply these settings.
          </p>
          <pre
            aria-label="JSON changes"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-control p-3 text-xs"
          >
            {JSON.stringify(draft.patch, null, 2)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={busy || reading}
              aria-busy={saving}
              onClick={async () => {
                if (await onApply(draft.patch)) {
                  setDraft(null);
                  setNotice('Automation JSON applied.');
                }
              }}
            >
              {saving ? 'Applying JSON…' : 'Apply JSON'}
            </button>
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
