import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  memo,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import {
  downloadFilename,
  fetchSandboxArtifact,
} from '@/utils/app/sandboxArtifactDownload';

interface SandboxArtifactLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children?: ReactNode;
}

export const SandboxArtifactLink = memo(
  ({ href, children, className, ...props }: SandboxArtifactLinkProps) => {
    const { saveFile, fileSaveDialog } = useFileSave();
    const [isPreparing, setIsPreparing] = useState(false);
    const [error, setError] = useState('');
    const abortControllerRef = useRef<AbortController | null>(null);

    useEffect(
      () => () => {
        abortControllerRef.current?.abort();
      },
      [],
    );

    const handleDownload = async (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (isPreparing) return;

      abortControllerRef.current?.abort();
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      setIsPreparing(true);
      setError('');

      try {
        const response = await fetchSandboxArtifact(href, {
          signal: abortController.signal,
        });
        const blob = await response.blob();
        if (abortController.signal.aborted) return;
        saveFile(
          blob,
          downloadFilename(response.headers.get('content-disposition')),
        );
      } catch (downloadError) {
        if (
          downloadError instanceof DOMException &&
          downloadError.name === 'AbortError'
        ) {
          return;
        }
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : 'The download could not be prepared. Please try again.',
        );
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
          setIsPreparing(false);
        }
      }
    };

    return (
      <span className="inline">
        {fileSaveDialog}
        <a
          {...props}
          href={href}
          className={className}
          download
          target={undefined}
          rel="noopener"
          aria-busy={isPreparing}
          aria-disabled={isPreparing}
          onClick={handleDownload}
        >
          {children}
        </a>
        {isPreparing && (
          <span role="status" className="ml-1 text-xs text-dark-text-muted">
            Preparing download…
          </span>
        )}
        {error && (
          <span role="alert" className="ml-1 text-xs text-nvidia-red">
            {error} Select the link to retry.
          </span>
        )}
      </span>
    );
  },
);

SandboxArtifactLink.displayName = 'SandboxArtifactLink';
