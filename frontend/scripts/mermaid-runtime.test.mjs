import mermaid from 'mermaid/dist/mermaid.esm.min.mjs';

import { describe, expect, it } from 'vitest';

describe('pinned Mermaid runtime', () => {
  it.each([
    ['flowchart-v2', 'flowchart TD\n  A --> B'],
    [
      'architecture',
      'architecture-beta\n  group api(cloud)[API]\n  service db(database)[Database] in api',
    ],
  ])('parses a %s diagram', async (diagramType, source) => {
    await expect(mermaid.parse(source)).resolves.toMatchObject({ diagramType });
  });
});
