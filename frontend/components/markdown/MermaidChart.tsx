import { IconCheck, IconClipboard, IconDownload } from '@tabler/icons-react';
import {
  FC,
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { useFileSave } from '@/hooks/useFileSave';

import { toPng } from 'html-to-image';
// Mermaid 11.16.1's browser bundle contains the matching parser. Its default
// core entry imports parser 1.2.0, which is not available in npm metadata.
import mermaid from 'mermaid/dist/mermaid.esm.min.mjs';

interface Props {
  value: string;
}

export const MermaidChart: FC<Props> = memo(({ value }) => {
  const { saveFile, fileSaveDialog } = useFileSave();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const uniqueId = useId().replace(/:/g, '_');

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
          // Resolve the shared stack so downloaded SVGs keep their fonts even
          // outside the page that defines the CSS variable.
          fontFamily: getComputedStyle(document.documentElement)
            .getPropertyValue('--font-mono')
            .trim(),
        });
        // Validate first
        await mermaid.parse(value);
        const { svg: renderedSvg } = await mermaid.render(
          `mermaid-${uniqueId}`,
          value,
        );
        if (!cancelled) {
          setSvg(renderedSvg);
          setError('');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Failed to render Mermaid diagram');
          setSvg('');
        }
      }
    };

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [value, uniqueId]);

  const copySource = useCallback(() => {
    navigator.clipboard?.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    });
  }, [value]);

  const downloadPng = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      const dataUrl = await toPng(containerRef.current, {
        backgroundColor: '#1e1e1e',
      });
      const blob = await (await fetch(dataUrl)).blob();
      saveFile(blob, 'mermaid-diagram.png');
    } catch {
      saveFile(
        new Blob([svg], { type: 'image/svg+xml' }),
        'mermaid-diagram.svg',
      );
    }
  }, [svg, saveFile]);

  if (error) {
    return (
      <div
        className="codeblock relative text-[16px]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {fileSaveDialog}
        <div className="flex items-center justify-between py-1.5 px-4">
          <span className="text-xs lowercase text-white">mermaid (error)</span>
        </div>
        <div className="p-4 bg-red-900/30 text-red-300 text-sm whitespace-pre-wrap overflow-auto max-h-[50vh]">
          {error}
          <hr className="my-3 border-red-700/50" />
          <code className="text-gray-300 text-xs">{value}</code>
        </div>
      </div>
    );
  }

  return (
    <div
      className="codeblock relative text-[16px]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {fileSaveDialog}
      <div className="flex items-center justify-between py-1.5 px-4">
        <span className="text-xs lowercase text-white">mermaid</span>
        <div className="flex items-center">
          <button
            className="flex gap-1.5 items-center rounded bg-none p-1 text-xs text-white"
            onClick={copySource}
          >
            {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
            {isCopied ? 'Copied!' : 'Copy source'}
          </button>
          {svg && (
            <button
              className="flex items-center rounded bg-none p-1 text-xs text-white"
              aria-label="Download diagram"
              onClick={downloadPng}
            >
              <IconDownload size={18} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        className="p-4 bg-[#1e1e1e] overflow-auto max-h-[60vh] flex justify-center"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
    </div>
  );
});

MermaidChart.displayName = 'MermaidChart';
