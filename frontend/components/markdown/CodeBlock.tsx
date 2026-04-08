import { IconCheck, IconClipboard, IconCode, IconDownload, IconEye } from '@tabler/icons-react';
import { FC, memo, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism';

import { useTranslation } from 'next-i18next';

import {
  generateRandomString,
  programmingLanguages,
} from '@/utils/app/codeblock';
import { Logger } from '@/utils/logger';

const logger = new Logger('CodeBlock');

const HTML_PREVIEW_LANGUAGES = new Set(['html', 'htm']);

interface Props {
  language: string;
  value: string;
}

export const CodeBlock: FC<Props> = memo(({ language, value }) => {
  const { t } = useTranslation('markdown');
  const [isCopied, setIsCopied] = useState<boolean>(false);
  const [showPreview, setShowPreview] = useState<boolean>(false);

  const isHtml = HTML_PREVIEW_LANGUAGES.has(language.toLowerCase());

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
        })()


  const copyToClipboard = (e: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
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
    // const fileName = window.prompt(
    //   t('Enter file name') || '',
    //   suggestedFileName,
    // );

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
    <div className="codeblock relative text-[16px]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div className="flex items-center justify-between py-1.5 px-4">
        <span className="text-xs lowercase text-white">{language}</span>

        <div className="flex items-center">
          {isHtml && (
            <button
              className="flex gap-1.5 items-center rounded bg-none p-1 text-xs text-white hover:text-nvidia-green transition-colors"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowPreview(!showPreview); }}
            >
              {showPreview ? <IconCode size={18} /> : <IconEye size={18} />}
              {showPreview ? t('Code') : t('Preview')}
            </button>
          )}
          <button
            className="flex gap-1.5 items-center rounded bg-none p-1 text-xs text-white"
            onClick={(e) => copyToClipboard(e)}
          >
            {isCopied ? <IconCheck size={18} /> : <IconClipboard size={18} />}
            {isCopied ? t('Copied!') : t('Copy code')}
          </button>
          <button
            className="flex items-center rounded bg-none p-1 text-xs text-white"
            onClick={(e) => downloadAsFile(e)}
          >
            <IconDownload size={18} />
          </button>
        </div>
      </div>

      {isHtml && showPreview ? (
        <div className="relative bg-white rounded-b" style={{ minHeight: '120px' }}>
          <iframe
            srcDoc={formattedValue}
            sandbox="allow-scripts"
            title="HTML Preview"
            className="w-full rounded-b"
            style={{
              border: 'none',
              minHeight: '200px',
              maxHeight: '70vh',
              height: '400px',
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
            maxHeight: '50vh',
            display: 'block',
            boxSizing: 'border-box',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
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
            }
          }}
          wrapLongLines={true}
        >
          {formattedValue}
        </SyntaxHighlighter>
      )}
    </div>
  );
});
CodeBlock.displayName = 'CodeBlock';
