/**
 * Markdown Examples Component
 *
 * This component demonstrates all the markdown and LaTeX features
 * supported by the application. Use this for testing and as a reference.
 */

import { FC, useState } from 'react';
import { MarkdownRenderer, MARKDOWN_EXAMPLES } from './MarkdownRenderer';

type ExampleType = 'basic' | 'math' | 'advanced' | 'scientific';

export const MarkdownExamples: FC = () => {
  const [selectedExample, setSelectedExample] = useState<ExampleType>('basic');
  const [customContent, setCustomContent] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const examples: Record<ExampleType, { title: string; description: string }> = {
    basic: {
      title: 'Basic Markdown',
      description: 'Headings, lists, bold, italic, and more',
    },
    math: {
      title: 'Math & LaTeX',
      description: 'Inline and display math equations',
    },
    advanced: {
      title: 'Advanced Features',
      description: 'Tables, code blocks, task lists, blockquotes',
    },
    scientific: {
      title: 'Scientific Notation',
      description: 'Physics, statistics, and complex equations',
    },
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-50 mb-3">
            Markdown & LaTeX Examples
          </h1>
          <p className="text-gray-600 dark:text-gray-400 text-lg">
            Comprehensive demonstration of markdown and math rendering capabilities
          </p>
        </div>

        {/* Example Selection */}
        <div className="mb-6 flex flex-wrap gap-3">
          {(Object.keys(examples) as ExampleType[]).map((key) => (
            <button
              key={key}
              onClick={() => {
                setSelectedExample(key);
                setShowCustom(false);
              }}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                selectedExample === key && !showCustom
                  ? 'bg-nvidia-green text-white shadow-lg'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {examples[key].title}
            </button>
          ))}
          <button
            onClick={() => setShowCustom(true)}
            className={`px-4 py-2 rounded-lg font-medium transition-all ${
              showCustom
                ? 'bg-nvidia-green text-white shadow-lg'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            Custom Input
          </button>
        </div>

        {/* Description */}
        {!showCustom && (
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
            <p className="text-blue-900 dark:text-blue-100">
              {examples[selectedExample].description}
            </p>
          </div>
        )}

        {/* Custom Input */}
        {showCustom && (
          <div className="mb-6">
            <textarea
              value={customContent}
              onChange={(e) => setCustomContent(e.target.value)}
              placeholder="Enter your markdown here... Try adding math with $x^2$ or $$\int x dx$$"
              className="w-full h-48 p-4 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono text-sm"
            />
          </div>
        )}

        {/* Rendered Output */}
        <div className="grid md:grid-cols-2 gap-6">
          {/* Source Code */}
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-4">
              Source Code
            </h2>
            <div className="bg-gray-900 dark:bg-black rounded-lg p-4 overflow-auto">
              <pre className="text-green-400 text-sm font-mono whitespace-pre-wrap">
                {showCustom ? customContent : MARKDOWN_EXAMPLES[selectedExample]}
              </pre>
            </div>
          </div>

          {/* Rendered Output */}
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-4">
              Rendered Output
            </h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 overflow-auto">
              <MarkdownRenderer
                content={showCustom ? customContent : MARKDOWN_EXAMPLES[selectedExample]}
              />
            </div>
          </div>
        </div>

        {/* Quick Reference */}
        <div className="mt-12 p-6 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-4">
            Quick Reference
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-2">
                Inline Math
              </h3>
              <code className="text-sm bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded">
                $x = \frac{'{-b \\pm \\sqrt{b^2-4ac}}{2a}'}$
              </code>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-2">
                Display Math
              </h3>
              <code className="text-sm bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded">
                $$\int_0^\infty e^{'{-x^2}'} dx$$
              </code>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-2">
                Code Blocks
              </h3>
              <code className="text-sm bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded">
                ```python<br />
                def hello():<br />
                &nbsp;&nbsp;print("Hello")
                <br />
                ```
              </code>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-50 mb-2">
                Tables
              </h3>
              <code className="text-sm bg-gray-100 dark:bg-gray-900 px-2 py-1 rounded">
                | Col1 | Col2 |<br />
                |------|------|<br />
                | A | B |
              </code>
            </div>
          </div>
        </div>

        {/* Resources */}
        <div className="mt-8 p-6 bg-nvidia-green/10 dark:bg-nvidia-green/5 rounded-lg border border-nvidia-green/30 dark:border-nvidia-green/20">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-50 mb-3">
            Resources
          </h2>
          <ul className="space-y-2 text-gray-700 dark:text-gray-300">
            <li>
              <a
                href="https://katex.org/docs/supported.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-nvidia-green hover:underline font-medium"
              >
                📚 KaTeX Supported Functions
              </a>
            </li>
            <li>
              <a
                href="https://github.github.com/gfm/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-nvidia-green hover:underline font-medium"
              >
                📝 GitHub Flavored Markdown Spec
              </a>
            </li>
            <li>
              <a
                href="https://www.markdownguide.org/basic-syntax/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-nvidia-green hover:underline font-medium"
              >
                ✍️ Markdown Guide
              </a>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
};

export default MarkdownExamples;
