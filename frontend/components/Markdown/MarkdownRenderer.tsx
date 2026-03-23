import { FC, memo } from 'react';
import ReactMarkdown, { Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { sanitizeSchema } from '@/utils/app/sanitizeSchema';
import { getReactMarkDownCustomComponents } from './CustomComponents';
import { normalizeLatexDelimiters } from '@/utils/app/latexNormalizer';

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
    const normalizedContent = enableMath ? normalizeLatexDelimiters(content) : content;

    // Build rehype plugins
    const rehypePlugins: any[] = allowHtml ? [rehypeRaw, [rehypeSanitize, sanitizeSchema]] : [];
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
      prevProps.className === nextProps.className
    );
  }
);

MarkdownRenderer.displayName = 'MarkdownRenderer';

/**
 * Markdown examples for testing
 */
export const MARKDOWN_EXAMPLES = {
  basic: `# Heading 1
## Heading 2
### Heading 3

**Bold text** and *italic text* and ***bold italic***

- Bullet point 1
- Bullet point 2
  - Nested point

1. Numbered item
2. Another item`,

  math: `# Math Examples

## Inline Math
The quadratic formula is $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$

The famous equation: $E = mc^2$

## Display Math (Block)

$$
\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}
$$

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$

## Matrix

$$
\\begin{bmatrix}
a & b \\\\
c & d
\\end{bmatrix}
$$`,

  advanced: `# Advanced Features

## Tables

| Feature | Supported | Notes |
|---------|-----------|-------|
| Tables | ✅ | GitHub Flavored Markdown |
| Math | ✅ | KaTeX rendering |
| Code | ✅ | Syntax highlighting |
| Images | ✅ | Responsive |

## Code Block

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)

print(fibonacci(10))
\`\`\`

## Inline Code

Use \`const x = 42;\` for inline code.

## Task Lists

- [x] Completed task
- [ ] Pending task
- [ ] Another task

## Blockquotes

> This is a blockquote.
> It can span multiple lines.

## Links

[Visit Example](https://example.com)`,

  scientific: `# Scientific Notation

## Physics

The Schrödinger equation:

$$
i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf{r},t) = \\hat{H}\\Psi(\\mathbf{r},t)
$$

Maxwell's equations in vacuum:

$$
\\begin{aligned}
\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\epsilon_0} \\\\
\\nabla \\cdot \\mathbf{B} &= 0 \\\\
\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\
\\nabla \\times \\mathbf{B} &= \\mu_0\\mathbf{J} + \\mu_0\\epsilon_0\\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{aligned}
$$

## Statistics

The normal distribution probability density function:

$$
f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{1}{2}\\left(\\frac{x-\\mu}{\\sigma}\\right)^2}
$$

Bayes' theorem:

$$
P(A|B) = \\frac{P(B|A)P(A)}{P(B)}
$$`,
};
