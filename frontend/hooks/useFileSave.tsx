import { useCallback, useState } from 'react';

import { isIOS } from '@/utils/app/platform';
import { saveArtifactBlob } from '@/utils/app/sandboxArtifactDownload';

import { Button } from '@/components/primitives';
import { ModalSurface } from '@/components/surfaces/ModalSurface';

/** Async preparation can outlive Safari's tap permission. A fresh Save tap
 * opens the native sheet without navigating away from a Home Screen app. */
export function useFileSave() {
  const [file, setFile] = useState<File | null>(null);
  const saveFile = useCallback((blob: Blob, filename: string): boolean => {
    if (isIOS()) {
      setFile(new File([blob], filename, { type: blob.type }));
      return false;
    }
    saveArtifactBlob(blob, filename);
    return true;
  }, []);

  return {
    saveFile,
    fileSaveDialog: file ? (
      <FileSaveDialog file={file} onClose={() => setFile(null)} />
    ) : null,
  };
}

function FileSaveDialog({
  file,
  onClose,
}: {
  file: File;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const supported = Boolean(
    typeof navigator.share === 'function' &&
      navigator.canShare?.({ files: [file] }),
  );

  async function save() {
    if (saving || !supported) return;
    setSaving(true);
    setError('');
    try {
      // No fetch or other await before share: preserve transient activation.
      await navigator.share({ files: [file] });
      onClose();
    } catch (cause) {
      // Dismissing the system sheet never falls through to an iOS preview.
      if (
        (cause instanceof DOMException || cause instanceof Error) &&
        cause.name === 'AbortError'
      )
        onClose();
      else setError('Could not open the save sheet. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalSurface
      open
      onClose={onClose}
      aria-label="Save file"
      className="w-full max-w-sm rounded-2xl border border-separator bg-panel p-5 text-primary shadow-xl"
    >
      <h2 className="text-lg font-semibold">Save file</h2>
      <p className="mt-2 break-all text-sm">{file.name}</p>
      <p className="mt-2 text-sm text-muted">
        {supported
          ? 'Tap Save, then choose Save to Files or Save Image in the share sheet.'
          : 'This browser cannot share this file. Open Daedalus in Safari to save it.'}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-nvidia-red">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="accent"
          onClick={save}
          disabled={!supported || saving}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </ModalSurface>
  );
}
