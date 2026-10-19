import {
  IconCheck,
  IconClipboard,
  IconCode,
  IconDownload,
  IconEye,
} from '@tabler/icons-react';
import { FC, memo, useEffect, useMemo, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

import { useFileSave } from '@/hooks/useFileSave';

import {
  generateRandomString,
  programmingLanguages,
} from '@/utils/app/codeblock';

import classNames from 'classnames';

const HTML_PREVIEW_LANGUAGES = new Set(['html', 'htm']);
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** JSON text with insignificant whitespace (outside strings) removed. */
function compactJsonText(source: string): string {
  let compact = '';
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      compact += char;
      if (char === '\\') compact += source[++index] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      compact += char;
    } else if (!JSON_WHITESPACE.has(char)) {
      compact += char;
    }
  }
  return compact;
}

/**
 * Pretty-print JSON only when re-serializing reproduces every token. Large
 * integers, number spellings, escapes and duplicate keys otherwise change in
 * the displayed, copied and downloaded code.
 */
function formatCodeValue(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  return JSON.stringify(parsed) === compactJsonText(value)
    ? JSON.stringify(parsed, null, 2)
    : value;
}

interface Props {
  language: string;
  value: string;
  defaultPreview?: boolean;
  fullscreen?: boolean;
}

export const CodeBlock: FC<Props> = memo(
  ({ language, value, defaultPreview = true, fullscreen = false }) => {
    const { saveFile, fileSaveDialog } = useFileSave();
    const [isCopied, setIsCopied] = useState<boolean>(false);

    const isHtml = HTML_PREVIEW_LANGUAGES.has(language.toLowerCase());
    const [showPreview, setShowPreview] = useState<boolean>(
      () => isHtml && defaultPreview,
    );

    useEffect(() => {
      setShowPreview(isHtml && defaultPreview);
    }, [defaultPreview, isHtml, value]);

    const formattedValue = useMemo(() => formatCodeValue(value), [value]);

    const copyToClipboard = (e: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard ||
        !navigator.clipboard.writeText
      ) {
        return;
      }

      navigator.clipboard.writeText(formattedValue).then(() => {
        setIsCopied(true);

        setTimeout(() => {
          setIsCopied(false);
        }, 2000);
      });
    };

    const downloadAsFile = (e: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();
      const fileExtension = programmingLanguages[language] || '.file';
      const suggestedFileName = `file-${generateRandomString(
        3,
        true,
      )}${fileExtension}`;

      const blob = new Blob([formattedValue], { type: 'text/plain' });
      saveFile(blob, suggestedFileName);
    };

    return (
      <div
        className={classNames(
          'codeblock relative text-[16px]',
          fullscreen && 'flex h-full min-h-0 flex-col',
        )}
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {fileSaveDialog}
        <div className="flex items-center justify-between py-1.5 px-4">
          <span className="text-xs lowercase text-primary">{language}</span>

          <div className="flex items-center">
            {isHtml && (
              <button
                className="flex min-h-11 items-center gap-1.5 rounded bg-none px-2 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowPreview(!showPreview);
                }}
              >
                {showPreview ? <IconCode size={18} /> : <IconEye size={18} />}
                {showPreview ? 'Code' : 'Preview'}
              </button>
            )}
            <button
              aria-label={isCopied ? 'Copied' : 'Copy code'}
              className="flex min-h-11 items-center gap-1.5 rounded bg-none px-1.5 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
              onClick={(e) => copyToClipboard(e)}
            >
              {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
              {isCopied ? 'Copied!' : 'Copy code'}
            </button>
            <button
              aria-label="Download code"
              title="Download code"
              className="flex min-h-11 items-center rounded bg-none px-1.5 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9"
              onClick={(e) => downloadAsFile(e)}
            >
              <IconDownload size={18} />
            </button>
          </div>
        </div>

        {isHtml && showPreview ? (
          <div
            className={classNames(
              'relative rounded-b bg-white',
              fullscreen && 'min-h-0 flex-1',
            )}
            style={{ minHeight: fullscreen ? 0 : '120px' }}
          >
            <iframe
              srcDoc={formattedValue}
              sandbox="allow-scripts"
              title="HTML Preview"
              className={classNames(
                'w-full rounded-b',
                fullscreen && 'h-full min-h-0',
              )}
              style={{
                border: 'none',
                minHeight: fullscreen ? '100%' : '200px',
                maxHeight: fullscreen ? 'none' : '70vh',
                height: fullscreen ? '100%' : '400px',
                display: 'block',
                backgroundColor: 'rgb(var(--palette-white))',
              }}
            />
          </div>
        ) : (
          <SyntaxHighlighter
            language={language}
            useInlineStyles={false}
            customStyle={{
              margin: 0,
              maxWidth: '100%',
              maxHeight: fullscreen ? 'none' : '50vh',
              height: fullscreen ? '100%' : undefined,
              flex: fullscreen ? 1 : undefined,
              minHeight: fullscreen ? 0 : undefined,
              display: 'block',
              boxSizing: 'border-box',
              // Preserve indentation and scroll horizontally instead of
              // wrapping lines arbitrarily (unreadable for code).
              whiteSpace: 'pre',
              wordBreak: 'normal',
              overflowX: 'auto',
              overflowY: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: '14px',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--font-mono)',
                fontSize: '14px',
              },
            }}
            wrapLongLines={false}
          >
            {formattedValue}
          </SyntaxHighlighter>
        )}
      </div>
    );
  },
);
CodeBlock.displayName = 'CodeBlock';
