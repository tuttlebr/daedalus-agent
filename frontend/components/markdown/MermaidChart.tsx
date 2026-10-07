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
import { useTheme } from '@/hooks/useTheme';

import { toPng } from 'html-to-image';
// Mermaid 11.16.1's browser bundle contains the matching parser. Its default
// core entry imports parser 1.2.0, which is not available in npm metadata.
import mermaid from 'mermaid/dist/mermaid.esm.min.mjs';

interface Props {
  value: string;
}

export const MermaidChart: FC<Props> = memo(({ value }) => {
  const { saveFile, fileSaveDialog } = useFileSave();
  const { isDark } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const uniqueId = useId().replace(/:/g, '_');

  useEffect(() => {
    let cancelled = false;

    const renderDiagram = async () => {
      try {
        const theme = getComputedStyle(document.documentElement);
        // Mermaid's color derivation requires resolved hex, not CSS variables.
        const color = (token: string) =>
          '#' +
          theme
            .getPropertyValue(token)
            .trim()
            .split(/\s+/)
            .map((channel) => Number(channel).toString(16).padStart(2, '0'))
            .join('');
        const surface = color('--control');
        const label = color('--label');
        const border = color('--border-control');
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          themeVariables: {
            darkMode: isDark,
            background: surface,
            primaryColor: surface,
            secondaryColor: surface,
            tertiaryColor: surface,
            primaryTextColor: label,
            secondaryTextColor: label,
            tertiaryTextColor: label,
            primaryBorderColor: border,
            secondaryBorderColor: border,
            tertiaryBorderColor: border,
            textColor: label,
            lineColor: border,
            edgeLabelBackground: surface,
            clusterBkg: surface,
            clusterBorder: border,
            noteBkgColor: color('--palette-mauve'),
            noteTextColor: color('--palette-navy'),
            noteBorderColor: border,
            actorBkg: surface,
            actorTextColor: label,
            actorBorder: border,
            actorLineColor: border,
            signalColor: label,
            signalTextColor: label,
            labelBoxBkgColor: surface,
            labelBoxBorderColor: border,
            labelTextColor: label,
            loopTextColor: label,
            activationBkgColor: surface,
            activationBorderColor: border,
            sequenceNumberColor: surface,
            errorBkgColor: surface,
            errorTextColor: label,
          },
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
  }, [value, uniqueId, isDark]);

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
        backgroundColor: getComputedStyle(containerRef.current).backgroundColor,
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
          <span className="text-xs lowercase text-primary">
            mermaid (error)
          </span>
        </div>
        <div className="p-4 bg-error/30 text-primary text-sm whitespace-pre-wrap overflow-auto max-h-[50vh]">
          {error}
          <hr className="my-3 border-error" />
          <code className="text-secondary text-xs">{value}</code>
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
        <span className="text-xs lowercase text-primary">mermaid</span>
        <div className="flex items-center">
          <button
            className="flex gap-1.5 items-center rounded bg-none p-1 text-xs text-primary"
            onClick={copySource}
          >
            {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
            {isCopied ? 'Copied!' : 'Copy source'}
          </button>
          {svg && (
            <button
              className="flex items-center rounded bg-none p-1 text-xs text-primary"
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
        className="p-4 bg-elevated overflow-auto max-h-[60vh] flex justify-center"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
    </div>
  );
});

MermaidChart.displayName = 'MermaidChart';
