// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';

const frontend = join(__dirname, '../..');
const config = require('../../tailwind.config.js');
const NOT_SOURCE = new Set(['node_modules', '__tests__', 'e2e', 'public']);

/** Top-level directories with components that render Tailwind class names. */
function directoriesRenderingClassNames(directory = frontend): Set<string> {
  const found = new Set<string>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !NOT_SOURCE.has(entry.name))
        directoriesRenderingClassNames(path).forEach((name) => found.add(name));
    } else if (
      entry.name.endsWith('.tsx') &&
      readFileSync(path, 'utf8').includes('className=')
    ) {
      found.add(relative(frontend, path).split('/')[0]);
    }
  }
  return found;
}

describe('Tailwind content sources', () => {
  it('scans every source directory that renders class names', () => {
    const globs: string[] = config.content;
    const uncovered = [...directoriesRenderingClassNames()].filter(
      (directory) => !globs.some((glob) => glob.startsWith(`./${directory}/`)),
    );
    expect(uncovered).toEqual([]);
  });

  it('generates utilities used only by hook-rendered UI', async () => {
    const result = await postcss([
      tailwindcss({
        ...config,
        content: config.content.map((glob: string) => join(frontend, glob)),
      }),
    ]).process('@tailwind utilities;', { from: undefined });
    // The save-file dialog in hooks/useFileSave.tsx is the only user.
    expect(result.css).toContain('.text-nvidia-red');
  });
});
