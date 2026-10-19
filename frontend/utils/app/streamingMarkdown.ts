/**
 * Split a streaming Markdown answer into top-level blocks.
 *
 * While an answer streams, each flush used to re-parse the whole text, which
 * costs O(n²) over a turn. Blocks before the last one are complete: text that
 * arrives later cannot change how they parse, so a renderer can keep their
 * output and re-parse only the growing tail.
 *
 * A split is made only before a line that starts a new top-level block after
 * a blank line, and only where everything before it is self-contained:
 *
 * - never inside a fenced code block (``` or ~~~, any indentation);
 * - never before an indented line or a list item, which can continue the
 *   preceding list or indented code;
 * - never while display math (`$$`, `\[`, `\(`, `\begin{equation|align}`),
 *   an HTML comment or a raw `<pre>`/`<script>`/`<style>`/`<textarea>` block
 *   is still open;
 * - never in a document with link reference or footnote definitions, which
 *   resolve across blocks.
 *
 * Rendering the blocks one by one, separated by a newline, yields the same
 * output as rendering the whole text. The completed answer is still rendered
 * whole by the full pipeline.
 */

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[*+-]|\d{1,9}[.)])(?:\s|$)/;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;
const MATH_DELIMITERS: Array<[RegExp, RegExp]> = [
  [/\\\[/g, /\\\]/g],
  [/\\\(/g, /\\\)/g],
  [/\\begin\{(?:equation|align)\*?\}/g, /\\end\{(?:equation|align)\*?\}/g],
];
const RAW_HTML_BLOCKS = ['pre', 'script', 'style', 'textarea'];

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Whether text from the block start so far leaves no construct open. */
function isSelfContained(prose: string): boolean {
  if (count(prose, /\$\$/g) % 2) return false;
  for (const [open, close] of MATH_DELIMITERS) {
    if (count(prose, open) > count(prose, close)) return false;
  }
  if (prose.lastIndexOf('<!--') > prose.lastIndexOf('-->')) return false;
  for (const tag of RAW_HTML_BLOCKS) {
    const opened = count(prose, new RegExp(`<${tag}(?=[\\s>])`, 'gi'));
    if (opened > count(prose, new RegExp(`</${tag}\\s*>`, 'gi'))) return false;
  }
  return true;
}

export function splitStreamingMarkdown(text: string): string[] {
  if (!text || DEFINITION.test(text)) return [text];

  const blocks: string[] = [];
  let blockStart = 0;
  // Block text outside code fences, for the open-construct checks.
  let prose = '';
  let fence: { char: string; length: number } | null = null;
  let afterBlank = false;
  let offset = 0;

  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(offset, end).replace(/\r?\n$/, '');

    if (fence) {
      const closing = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (
        closing &&
        closing[1][0] === fence.char &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
    } else if (!line.trim()) {
      afterBlank = true;
      prose += '\n';
    } else {
      if (
        afterBlank &&
        offset > blockStart &&
        !/^\s/.test(line) &&
        !LIST_ITEM.test(line) &&
        isSelfContained(prose)
      ) {
        blocks.push(text.slice(blockStart, offset));
        blockStart = offset;
        prose = '';
      }
      afterBlank = false;
      const opening = line.match(FENCE_OPEN);
      // A backtick fence's info string cannot contain backticks.
      const info = opening ? line.slice(opening[0].length) : '';
      if (opening && !(opening[1][0] === '`' && info.includes('`'))) {
        fence = { char: opening[1][0], length: opening[1].length };
      } else {
        prose += `${line}\n`;
      }
    }
    offset = end;
  }

  blocks.push(text.slice(blockStart));
  return blocks;
}
