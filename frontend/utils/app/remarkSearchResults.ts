import type { Html, Parent, Root } from 'mdast';
import type { VFile } from 'vfile';

function payloadHtml(source: string): string | undefined {
  try {
    JSON.parse(source);
  } catch {
    return undefined;
  }
  const escaped = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<searchresults>${escaped}</searchresults>`;
}

/** Preserve provider JSON before GFM links/emphasis become rendered children. */
export function remarkSearchResults() {
  return (tree: Root, file: VFile) => {
    const source = String(file.value);
    const visit = (parent: Parent) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        let child = parent.children[index];
        if (child.type === 'html') {
          const block = child.value.match(
            /^<searchresults>([\s\S]*)<\/searchresults>\s*$/i,
          );
          if (block) {
            child.value = payloadHtml(block[1]) ?? child.value;
          } else if (/^<searchresults>$/i.test(child.value)) {
            const start = child.position?.end.offset;
            if (start === undefined) continue;
            for (let end = index + 1; end < parent.children.length; end += 1) {
              const closing = parent.children[end];
              if (
                closing.type !== 'html' ||
                !/^<\/searchresults>$/i.test(closing.value) ||
                closing.position?.start.offset === undefined
              ) {
                continue;
              }
              const value = payloadHtml(
                source.slice(start, closing.position.start.offset),
              );
              // A literal closing tag inside a JSON string is not its boundary.
              if (value === undefined) continue;
              const html: Html = { type: 'html', value };
              parent.children.splice(index, end - index + 1, html);
              child = html;
              break;
            }
          }
        }
        if ('children' in child) {
          visit(child);
          if (
            child.type === 'paragraph' &&
            child.children.length === 1 &&
            child.children[0].type === 'html' &&
            child.children[0].value.startsWith('<searchresults>')
          ) {
            parent.children[index] = child.children[0];
          }
        }
      }
    };
    visit(tree);
  };
}
