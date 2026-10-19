/** Convert explicit LaTeX delimiters in a non-code Markdown fragment.
 * Double dollars also support inline math with singleDollarTextMath disabled,
 * so ordinary prices remain literal. The remark plugin preserves display mode.
 */
export function normalizeLatexDelimiters(
  text: string,
  onMath?: (offset: number, display: boolean) => void,
): string {
  if (!text) return text;
  let delta = 0;
  return text.replace(
    /\\(?:\[([\s\S]*?)\\\]|\(([\s\S]*?)\\\)|begin\{(equation\*?|align\*?)\}([\s\S]*?)\\end\{\3\})/g,
    (match, display, inline, environment, body, offset: number) => {
      // A literal escaped backslash does not open a math expression.
      let precedingSlashes = 0;
      for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) {
        precedingSlashes++;
      }
      if (precedingSlashes % 2) return match;
      const content = environment?.startsWith('align')
        ? `\\begin{aligned}${body}\\end{aligned}`
        : display ?? inline ?? body;
      const replacement = `$$${content}$$`;
      onMath?.(offset + delta, inline === undefined);
      delta += replacement.length - match.length;
      return replacement;
    },
  );
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
}

/** Normalize using the real Markdown parser's code boundaries, including
 * nested fences, indented blocks, and variable-length inline code delimiters.
 * Ordinary messages keep their original parse; only changed math is reparsed.
 */
export function remarkLatexDelimiters(this: {
  parse: (source: string) => MarkdownNode;
}) {
  return (tree: MarkdownNode, file: { toString: () => string }) => {
    const source = file.toString();
    if (!/\\(?:\[|\(|begin\{(?:equation|align)\*?\})/.test(source)) return tree;
    const protectedRanges: Array<[number, number]> = [];
    let htmlCode: { start: number; tag: string } | undefined;
    const visit = (node: MarkdownNode, fn: (node: MarkdownNode) => boolean) => {
      if (fn(node)) node.children?.forEach((child) => visit(child, fn));
    };
    visit(tree, (node) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type === 'html' && start !== undefined && end !== undefined) {
        const value = node.value || '';
        const open = /^<(code|pre)(?:\s|>)/i.exec(value);
        if (htmlCode && new RegExp(`</${htmlCode.tag}\\s*>`, 'i').test(value)) {
          protectedRanges.push([htmlCode.start, end]);
          htmlCode = undefined;
        } else if (!htmlCode && open && !/<\/(?:code|pre)\s*>/i.test(value)) {
          htmlCode = { start, tag: open[1] };
        }
      }
      if (
        ['code', 'inlineCode', 'html', 'math', 'inlineMath'].includes(node.type)
      ) {
        if (start !== undefined && end !== undefined)
          protectedRanges.push([start, end]);
        return false;
      }
      return true;
    });
    if (htmlCode) protectedRanges.push([htmlCode.start, source.length]);
    protectedRanges.sort(([a], [b]) => a - b);
    let normalized = '';
    let cursor = 0;
    const displayOffsets = new Set<number>();
    for (const [start, end] of [
      ...protectedRanges,
      [source.length, source.length],
    ]) {
      // HTML code containers can enclose other protected Markdown nodes.
      if (end <= cursor) continue;
      const nextStart = Math.max(cursor, start);
      const base = normalized.length;
      normalized += normalizeLatexDelimiters(
        source.slice(cursor, nextStart),
        (offset, display) => {
          if (display) displayOffsets.add(base + offset);
        },
      );
      normalized += source.slice(nextStart, end);
      cursor = end;
    }
    if (normalized === source) return tree;
    const result = this.parse(normalized);
    visit(result, (node) => {
      if (
        node.type === 'inlineMath' &&
        displayOffsets.has(node.position?.start.offset ?? -1)
      ) {
        // Keep the inline node's valid HTML nesting while asking KaTeX for
        // display layout, including within a list or blockquote paragraph.
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            className: ['math', 'math-display'],
          },
        };
      }
      return true;
    });
    return result;
  };
}

/**
 * Checks if a string contains LaTeX expressions
 * @param text - The text to check
 * @returns true if LaTeX expressions are detected
 */
export function containsLatex(text: string): boolean {
  if (!text) return false;

  // Check for various LaTeX delimiters
  const patterns = [
    /\$\$[\s\S]*?\$\$/, // $$...$$
    /\$[^\$\n]+\$/, // $...$
    /\\\[[\s\S]*?\\\]/, // \[...\]
    /\\\([\s\S]*?\\\)/, // \(...\)
    /\\begin\{equation\*?\}/, // equation environments
    /\\begin\{align\*?\}/, // align environments
    /\\frac\{/, // \frac command
    /\\sqrt\{/, // \sqrt command
    /\\sum/, // \sum command
    /\\int/, // \int command
  ];

  return patterns.some((pattern) => pattern.test(text));
}
