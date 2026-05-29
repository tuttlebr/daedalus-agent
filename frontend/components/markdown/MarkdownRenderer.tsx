import { FC, memo } from 'react';
import ReactMarkdown, { Options } from 'react-markdown';

import { normalizeLatexDelimiters } from '@/utils/app/latexNormalizer';
import { sanitizeSchema } from '@/utils/app/sanitizeSchema';

import { getReactMarkDownCustomComponents } from './CustomComponents';

import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

interface MarkdownRendererProps extends Omit<Options, 'children'> {
  content: string;
  messageIndex?: number;
  messageId?: string;
  className?: string;
  allowHtml?: boolean;
  enableMath?: boolean;
}

/**
 * Enhanced Markdown Renderer with full LaTeX/Math support
 *
 * Features:
 * - GitHub Flavored Markdown (tables, task lists, strikethrough, etc.)
 * - LaTeX math rendering via KaTeX (inline: $...$ and display: $$...$$)
 * - Code syntax highlighting
 * - Tables with proper styling
 * - Custom components (images, videos, charts)
 * - Dark mode support
 * - Mobile responsive
 *
 * @example
 * // Basic usage
 * <MarkdownRenderer content="# Hello **World**" />
 *
 * @example
 * // With math
 * <MarkdownRenderer
 *   content="The quadratic formula: $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$"
 *   enableMath={true}
 * />
 *
 * @example
 * // Display math (block)
 * <MarkdownRenderer content="$$\int_{0}^{\infty} e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$" />
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({
    content,
    messageIndex = 0,
    messageId = '',
    className = 'prose dark:prose-invert max-w-none',
    allowHtml = true,
    enableMath = true,
    ...props
  }) => {
    // Normalize LaTeX delimiters before processing
    const normalizedContent = enableMath
      ? normalizeLatexDelimiters(content)
      : content;

    // Build rehype plugins
    const rehypePlugins: any[] = allowHtml
      ? [rehypeRaw, [rehypeSanitize, sanitizeSchema]]
      : [];
    if (enableMath) {
      rehypePlugins.push(rehypeKatex);
    }

    // Build remark plugins
    const remarkPlugins: any[] = [remarkGfm];
    if (enableMath) {
      remarkPlugins.push([remarkMath, { singleDollarTextMath: false }]);
    }

    return (
      <ReactMarkdown
        className={className}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        linkTarget="_blank"
        components={getReactMarkDownCustomComponents(messageIndex, messageId)}
        {...props}
      >
        {normalizedContent}
      </ReactMarkdown>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.content === nextProps.content &&
      prevProps.messageIndex === nextProps.messageIndex &&
      prevProps.messageId === nextProps.messageId &&
      prevProps.className === nextProps.className &&
      prevProps.allowHtml === nextProps.allowHtml &&
      prevProps.enableMath === nextProps.enableMath
    );
  },
);

MarkdownRenderer.displayName = 'MarkdownRenderer';
