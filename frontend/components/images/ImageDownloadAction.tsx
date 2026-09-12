'use client';

import React, { useEffect, useId, useState } from 'react';

import { downloadFilename } from '@/utils/app/sandboxArtifactDownload';

interface ImageDownloadActionProps {
  imageId: string;
  icon: React.ReactNode;
  className: string;
}

export function ImageDownloadAction(props: ImageDownloadActionProps) {
  // Discard the prepared file and any pending save when selection changes.
  return <DownloadAction key={props.imageId} {...props} />;
}

function DownloadAction({
  imageId,
  icon,
  className,
}: ImageDownloadActionProps) {
  const [useSaveSheet, setUseSaveSheet] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const descriptionId = useId();
  const downloadUrl = `/api/generated-image/${imageId}?download=1`;

  useEffect(() => {
    // iPadOS can report a desktop Mac user agent. Direct downloads in iOS
    // Home Screen apps can replace the app with a preview with no way back:
    // https://bugs.webkit.org/show_bug.cgi?id=236943
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setUseSaveSheet(isIOS);
    if (!isIOS) return;

    if (!navigator.share || !navigator.canShare) {
      setUnsupported(true);
      return;
    }

    const controller = new AbortController();
    setError(null);
    // Prepare before the tap: awaiting a large download in the click handler
    // can expire Safari's user activation and prevent the save sheet opening.
    void (async () => {
      try {
        const response = await fetch(downloadUrl, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Image download failed');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        const original = new File(
          [blob],
          downloadFilename(response.headers.get('Content-Disposition')),
          { type: blob.type },
        );
        if (!navigator.canShare({ files: [original] })) {
          setUnsupported(true);
          return;
        }
        setFile(original);
      } catch {
        if (!controller.signal.aborted) {
          setError('Could not prepare the image. Try downloading again.');
        }
      }
    })();
    return () => controller.abort();
  }, [downloadUrl, attempt]);

  async function save() {
    if (!file) {
      setError(null);
      setAttempt((value) => value + 1);
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await navigator.share({ files: [file] });
    } catch (cause) {
      // Cancellation must stay in Create, without falling back to navigation.
      if (
        !(
          (cause instanceof DOMException || cause instanceof Error) &&
          cause.name === 'AbortError'
        )
      ) {
        setError('Could not open the save sheet. Try downloading again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (useSaveSheet === false) {
    return (
      <a href={downloadUrl} download className={className}>
        {icon}
        <span>Download</span>
      </a>
    );
  }

  const loading = useSaveSheet === null || (!file && !error && !unsupported);
  return (
    <>
      <button
        type="button"
        onClick={save}
        disabled={loading || saving || unsupported}
        aria-busy={loading || saving}
        aria-describedby={descriptionId}
        className={`${className} disabled:cursor-wait disabled:opacity-50`}
      >
        {icon}
        <span>{loading ? 'Preparing…' : saving ? 'Saving…' : 'Download'}</span>
      </button>
      <p
        id={descriptionId}
        role={error || unsupported ? 'alert' : undefined}
        className="col-span-full w-full text-xs text-muted"
      >
        {unsupported
          ? 'Saving is unavailable here. Open Daedalus in Safari to save this image.'
          : error || 'Choose “Save to Files” in the save sheet to download.'}
      </p>
    </>
  );
}
