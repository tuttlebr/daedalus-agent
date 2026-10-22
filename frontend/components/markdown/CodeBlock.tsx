import {
  IconCheck,
  IconClipboard,
  IconCode,
  IconDownload,
  IconEye,
  IconFileText,
} from '@tabler/icons-react';
import { FC, ReactNode, memo, useEffect, useMemo, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

import { useFileSave } from '@/hooks/useFileSave';

import {
  generateRandomString,
  programmingLanguages,
} from '@/utils/app/codeblock';

import {
  ToolbarButton,
  ToolbarGroup,
  ToolbarItems,
} from '@/components/layout/ToolbarSlot';

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
  /**
   * Presents the code as a response document. Its one header names it and
   * holds its commands, then `actions`; the message frames it, so it has no
   * card of its own. Fullscreen, the commands join the viewer's toolbar,
   * which names the document itself.
   */
  documentTitle?: string;
  actions?: ReactNode;
}

export const CodeBlock: FC<Props> = memo(
  ({
    language,
    value,
    defaultPreview = true,
    fullscreen = false,
    documentTitle,
    actions,
  }) => {
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

    const copyToClipboard = (e?: React.MouseEvent) => {
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

    const downloadAsFile = (e?: React.MouseEvent) => {
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

    const isDocument = documentTitle !== undefined;

    const headerControls = (
      <>
        {isHtml && (
          <button
            className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded bg-none px-2 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9 md:min-w-9"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowPreview(!showPreview);
            }}
          >
            {showPreview ? <IconCode size={18} /> : <IconEye size={18} />}
            <span className="codeblock-control-label">
              {showPreview ? 'Code' : 'Preview'}
            </span>
          </button>
        )}
        <button
          aria-label={isCopied ? 'Copied' : 'Copy code'}
          className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded bg-none px-1.5 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9 md:min-w-9"
          onClick={(e) => copyToClipboard(e)}
        >
          {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
          <span className="codeblock-control-label">
            {isCopied ? 'Copied!' : 'Copy code'}
          </span>
        </button>
        <button
          aria-label="Download code"
          title="Download code"
          className="flex min-h-11 min-w-11 items-center justify-center rounded bg-none px-1.5 text-xs text-primary transition-colors hover:text-nvidia-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:min-h-9 md:min-w-9"
          onClick={(e) => downloadAsFile(e)}
        >
          <IconDownload size={18} />
        </button>
      </>
    );

    const body =
      isHtml && showPreview ? (
        <div
          className={classNames(
            'relative bg-white',
            !isDocument && 'rounded-b',
            fullscreen && 'min-h-0 flex-1',
          )}
          style={{ minHeight: fullscreen ? 0 : '120px' }}
        >
          <iframe
            srcDoc={formattedValue}
            sandbox="allow-scripts"
            title="HTML Preview"
            className={classNames(
              'w-full',
              !isDocument && 'rounded-b',
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
            // Outside Markdown no prose rule pads the code from its frame.
            padding: isDocument ? '0.75rem 1rem' : undefined,
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
      );

    if (isDocument) {
      return (
        <div
          className={classNames(fullscreen && 'flex h-full min-h-0 flex-col')}
        >
          {fileSaveDialog}
          {fullscreen ? (
            <ToolbarItems>
              <ToolbarGroup label="Document commands">
                {isHtml && (
                  <ToolbarButton
                    icon={showPreview ? <IconCode /> : <IconEye />}
                    label={showPreview ? 'Show code' : 'Show preview'}
                    onClick={() => setShowPreview(!showPreview)}
                  />
                )}
                <ToolbarButton
                  icon={isCopied ? <IconCheck /> : <IconClipboard />}
                  label={isCopied ? 'Copied' : 'Copy code'}
                  onClick={() => copyToClipboard()}
                />
                <ToolbarButton
                  icon={<IconDownload />}
                  label="Download code"
                  onClick={() => downloadAsFile()}
                />
              </ToolbarGroup>
            </ToolbarItems>
          ) : (
            <div className="codeblock-document-header mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-xs text-dark-text-muted">
                <IconFileText
                  size={14}
                  className="flex-shrink-0 text-nvidia-green"
                />
                <span className="truncate">{documentTitle}</span>
              </div>
              {/* The last glyph, not its padding, meets the message's edge. */}
              <div className="-mr-2 flex flex-shrink-0 items-center">
                {headerControls}
                {actions}
              </div>
            </div>
          )}
          <div
            className={classNames(
              'codeblock codeblock-document-frame',
              fullscreen && 'flex min-h-0 flex-1 flex-col',
            )}
          >
            {body}
          </div>
        </div>
      );
    }

    return (
      <div
        className={classNames(
          'codeblock relative text-[16px]',
          fullscreen && 'flex h-full min-h-0 flex-col',
        )}
      >
        {fileSaveDialog}
        <div className="flex items-center justify-between py-1.5 px-4">
          <span className="text-xs lowercase text-primary">{language}</span>
          <div className="flex items-center">{headerControls}</div>
        </div>
        {body}
      </div>
    );
  },
);
CodeBlock.displayName = 'CodeBlock';
