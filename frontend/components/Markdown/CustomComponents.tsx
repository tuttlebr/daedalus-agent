
import { Children, memo, useMemo } from 'react';
import { isEqual } from '@/utils/data/isEqual';
import { LazyCodeBlock } from '@/components/Markdown/LazyCodeBlock';
import { LazyMermaidChart } from '@/components/Markdown/LazyMermaidChart';
import { LazyChart } from '@/components/Markdown/LazyChart';
import { LazySearchResults } from '@/components/Markdown/LazySearchResults';
import { Video } from '@/components/Markdown/Video';
import { Image } from '@/components/Markdown/Image';
import { Logger } from '@/utils/logger';

const logger = new Logger('CustomComponents');

// Type definitions for markdown components
type MarkdownComponentProps = {
  children?: React.ReactNode;
  href?: string;
  [key: string]: any;
};


export const getReactMarkDownCustomComponents = (messageIndex = 0, messageId = '') => {
  return useMemo(() => ({
    code: memo(
      ({ node, inline, className, children, ...props }: { children: React.ReactNode; inline?: boolean; [key: string]: any }) => {
        const childArray = Children.toArray(children);

        if (childArray.length > 0 && typeof childArray[0] === 'string') {
          const firstChild = childArray[0];
          if (firstChild === '▍') {
            return <span className="animate-pulse cursor-default mt-1">▍</span>;
          }
          childArray[0] = firstChild.replace('`▍`', '▍');
        }

        const textContent = childArray
          .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
          .join('');

        const match = /language-(\w+)/.exec(className || '');

        // Handle inline code
        if (inline) {
          return (
            <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-sm" {...props}>
              {childArray}
            </code>
          );
        }

        // Handle mermaid diagrams
        const detectedLang = (match && match.length > 1 && match[1]) || '';
        if (detectedLang === 'mermaid') {
          return <LazyMermaidChart key={Math.random()} value={textContent.replace(/\n$/, '')} />;
        }

        // Handle code blocks
        return <LazyCodeBlock
            key={Math.random()}
            language={detectedLang}
            value={textContent.replace(/\n$/, '')}
            {...props}
          />
      },
      (prevProps, nextProps) => {
        return isEqual(prevProps.children, nextProps.children);
      }
    ),

    chart: memo(({ children }: MarkdownComponentProps) => {
      try {
        const childArray = Children.toArray(children);
        const payloadString = childArray
          .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
          .join('')
          .replace(/\n/g, '');

        if (!payloadString) {
          return null;
        }

        const payload = JSON.parse(payloadString);
        return payload ? <LazyChart payload={payload} /> : null;
      } catch (error) {
        logger.error('Failed to parse chart payload:', error);
        return null;
      }
    }, (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    searchresults: memo(({ children }: MarkdownComponentProps) => {
      try {
        const childArray = Children.toArray(children);
        const payloadString = childArray
          .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
          .join('')
          .replace(/\n/g, '');

        if (!payloadString) {
          return null;
        }

        const payload = JSON.parse(payloadString);
        return payload ? <LazySearchResults payload={payload} /> : null;
      } catch (error) {
        logger.error('Failed to parse search results payload:', error);
        return null;
      }
    }, (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    table: memo(({ children }: MarkdownComponentProps) => (
      <table className="border-collapse border border-black dark:border-white w-full table-fixed my-3">
        {children}
      </table>
    ), (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    th: memo(({ children }: MarkdownComponentProps) => (
      <th className="border border-black bg-gray-500 px-3 py-1 text-white dark:border-white align-top" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
        {children}
      </th>
    ), (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    td: memo(({ children }: MarkdownComponentProps) => (
      <td className="border border-black px-3 py-1 dark:border-white align-top" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
        {children}
      </td>
    ), (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    a: memo(({ href, children, ...props }: MarkdownComponentProps) => (
      <a
        href={href}
        className="text-nvidia-green dark:text-nvidia-green-bright no-underline hover:underline font-medium transition-colors"
        {...props}
      >
        {children}
      </a>
    ), (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    li: memo(({ children, ...props }: MarkdownComponentProps) => (
      <li className="leading-[1.35rem] mb-1 list-disc" {...props}>
        {children}
      </li>
    ), (prevProps: MarkdownComponentProps, nextProps: MarkdownComponentProps) => isEqual(prevProps.children, nextProps.children)),

    sup: memo(({ children, ...props }: MarkdownComponentProps) => {
      const validContent = Array.isArray(children)
        ? children.filter(child => typeof child === 'string' && child.trim() && child.trim() !== ",").join("")
        : typeof children === 'string' && children.trim() && children.trim() !== "," ? children : null;

      return validContent ? (
        <sup
          className="text-xs bg-gray-100 dark:bg-neutral-800 text-nvidia-green border border-nvidia-green-light/30 px-1 py-0.5 rounded-md shadow-sm"
          style={{
            fontWeight: "bold",
            marginLeft: "2px",
            transform: "translateY(-3px)",
            fontSize: "0.7rem",
          }}
          {...props}
        >
          {validContent}
        </sup>
      ) : null;
    }, (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    p: memo(({ children, ...props }: { children: React.ReactNode; [key: string]: any }) => {
      return <p {...props}>{children}</p>;
    }, (prevProps, nextProps) => {
      return isEqual(prevProps.children, nextProps.children);
    }),

    h1: memo(({ children, ...props }: MarkdownComponentProps) => (
      <h1 className="text-3xl font-bold mt-6 mb-4 text-gray-900 dark:text-gray-50 border-b border-gray-200 dark:border-gray-700 pb-2" {...props}>
        {children}
      </h1>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    h2: memo(({ children, ...props }: MarkdownComponentProps) => (
      <h2 className="text-2xl font-bold mt-5 mb-3 text-gray-900 dark:text-gray-50" {...props}>
        {children}
      </h2>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    h3: memo(({ children, ...props }: MarkdownComponentProps) => (
      <h3 className="text-xl font-semibold mt-4 mb-2 text-gray-900 dark:text-gray-50" {...props}>
        {children}
      </h3>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    h4: memo(({ children, ...props }: MarkdownComponentProps) => (
      <h4 className="text-lg font-semibold mt-3 mb-2 text-gray-800 dark:text-gray-100" {...props}>
        {children}
      </h4>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    blockquote: memo(({ children, ...props }: MarkdownComponentProps) => (
      <blockquote
        className="border-l-4 border-nvidia-green dark:border-nvidia-green-bright pl-4 py-2 my-4 italic text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900/50 rounded-r"
        {...props}
      >
        {children}
      </blockquote>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    hr: memo(({ ...props }) => (
      <hr className="my-6 border-t-2 border-gray-200 dark:border-gray-700" {...props} />
    ), () => true),

    ul: memo(({ children, ...props }: MarkdownComponentProps) => (
      <ul className="list-disc list-outside ml-6 my-3 space-y-1" {...props}>
        {children}
      </ul>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    ol: memo(({ children, ...props }: MarkdownComponentProps) => (
      <ol className="list-decimal list-outside ml-6 my-3 space-y-1" {...props}>
        {children}
      </ol>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    strong: memo(({ children, ...props }: MarkdownComponentProps) => (
      <strong className="font-bold text-gray-900 dark:text-gray-50" {...props}>
        {children}
      </strong>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    em: memo(({ children, ...props }: MarkdownComponentProps) => (
      <em className="italic text-gray-800 dark:text-gray-200" {...props}>
        {children}
      </em>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    del: memo(({ children, ...props }: MarkdownComponentProps) => (
      <del className="line-through text-gray-600 dark:text-gray-400" {...props}>
        {children}
      </del>
    ), (prevProps, nextProps) => isEqual(prevProps.children, nextProps.children)),

    img: memo((props) => <Image {...props} />, (prevProps, nextProps) => isEqual(prevProps, nextProps)),
    video: memo((props) => <Video {...props} />, (prevProps, nextProps) => isEqual(prevProps, nextProps))
  }),[messageIndex, messageId]);
};
