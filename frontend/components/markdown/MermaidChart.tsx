import { IconCheck, IconClipboard, IconDownload } from '@tabler/icons-react';
import { FC, memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { toPng } from 'html-to-image';

interface Props {
  value: string;
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'strict',
  fontFamily: "'JetBrains Mono', monospace",
});

export const MermaidChart: FC<Props> = memo(({ value }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const uniqueId = useId().replace(/:/g, '_');

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        // Validate first
        await mermaid.parse(value);
        const { svg: renderedSvg } = await mermaid.render(`mermaid-${uniqueId}`, value);
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
    return () => { cancelled = true; };
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
      const dataUrl = await toPng(containerRef.current, { backgroundColor: '#1e1e1e' });
      const link = document.createElement('a');
      link.download = 'mermaid-diagram.png';
      link.href = dataUrl;
      link.click();
    } catch {
      // Fallback: download the SVG source
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = 'mermaid-diagram.svg';
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    }
  }, [svg]);

  if (error) {
    return (
      <div className="codeblock relative text-[16px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
    <div className="codeblock relative text-[16px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
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
