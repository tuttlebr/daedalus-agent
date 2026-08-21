import {
  IconCheck,
  IconClipboard,
  IconCode,
  IconDownload,
  IconEye,
} from '@tabler/icons-react';
import { FC, memo, useEffect, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import {
  generateRandomString,
  programmingLanguages,
} from '@/utils/app/codeblock';
import { Logger } from '@/utils/logger';

import classNames from 'classnames';

const logger = new Logger('CodeBlock');

const HTML_PREVIEW_LANGUAGES = new Set(['html', 'htm']);

interface Props {
  language: string;
  value: string;
  defaultPreview?: boolean;
  fullscreen?: boolean;
}

export const CodeBlock: FC<Props> = memo(
  ({ language, value, defaultPreview = true, fullscreen = false }) => {
    const [isCopied, setIsCopied] = useState<boolean>(false);

    const isHtml = HTML_PREVIEW_LANGUAGES.has(language.toLowerCase());
    const [showPreview, setShowPreview] = useState<boolean>(
      () => isHtml && defaultPreview,
    );

    useEffect(() => {
      setShowPreview(isHtml && defaultPreview);
    }, [defaultPreview, isHtml, value]);

    // Ensure value is a valid JSON string
    if (language === 'json') {
      try {
        value = value.replaceAll("'", '"');
      } catch (error) {
        logger.info('JSON parse error:', error);
      }
    }

    const formattedValue = (() => {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        return value; // Return the original value if parsing fails
      }
    })();

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

      if (!suggestedFileName) {
        return; // User pressed cancel on prompt
      }

      const blob = new Blob([formattedValue], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = suggestedFileName;
      link.href = url;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    };

    return (
      <div
        className={classNames(
          'codeblock relative text-[16px]',
          fullscreen && 'flex h-full min-h-0 flex-col',
        )}
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div className="flex items-center justify-between py-1.5 px-4">
          <span className="text-xs lowercase text-white">{language}</span>

          <div className="flex items-center">
            {isHtml && (
              <button
                className="flex min-h-11 items-center gap-1.5 rounded bg-none px-2 text-xs text-white transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:min-h-9"
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
              className="flex min-h-11 items-center gap-1.5 rounded bg-none px-1.5 text-xs text-white transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:min-h-9"
              onClick={(e) => copyToClipboard(e)}
            >
              {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
              {isCopied ? 'Copied!' : 'Copy code'}
            </button>
            <button
              aria-label="Download code"
              title="Download code"
              className="flex min-h-11 items-center rounded bg-none px-1.5 text-xs text-white transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvidia-green/40 md:min-h-9"
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
                backgroundColor: '#ffffff',
              }}
            />
          </div>
        ) : (
          <SyntaxHighlighter
            language={language}
            style={oneDark}
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
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '14px',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: {
                fontFamily: "'JetBrains Mono', monospace",
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
