// @vitest-environment node
import { generateBranding } from '../../scripts/generate-branding';

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'daedalus-branding-'));
  roots.push(root);
  mkdirSync(join(root, 'public/icons'), { recursive: true });
  const write = (file: string, content: string) =>
    writeFileSync(join(root, file), content);
  write('public/favicon.png', 'favicon');
  write('public/icons/icon-96x96.png', 'icon-v1');
  write(
    'public/manifest.json',
    JSON.stringify({
      id: '/daedalus-v2',
      start_url: '/',
      scope: '/',
      name: 'Daedalus',
      icons: [{ src: '/icons/icon-96x96.png', sizes: '96x96' }],
      shortcuts: [{ icons: [{ src: '/icons/icon-96x96.png' }] }],
    }),
  );
  write('public/offline.html', '<img src="/icons/icon-96x96.png">');
  write(
    'public/sw.js',
    '// BEGIN GENERATED BRANDING\n// END GENERATED BRANDING\n',
  );
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  return { root, read, write };
}

afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe('branding versions', () => {
  it('is deterministic and changes every consumer when only a PNG changes', () => {
    const { root, read, write } = fixture();
    const before = generateBranding(root);
    const outputs = [
      'generated/branding.ts',
      'public/manifest.json',
      'public/offline.html',
      'public/sw.js',
    ];
    const first = outputs.map(read);
    expect(generateBranding(root)).toEqual(before);
    expect(outputs.map(read)).toEqual(first);

    write('public/icons/icon-96x96.png', 'icon-v2');
    const after = generateBranding(root);
    expect(after.assets['/favicon.png']).toEqual(before.assets['/favicon.png']);
    expect(after.assets['/icons/icon-96x96.png']).not.toEqual(
      before.assets['/icons/icon-96x96.png'],
    );
    expect(after.manifest).not.toEqual(before.manifest);
    expect(after.version).not.toEqual(before.version);
    for (const content of outputs.map(read)) {
      expect(content).toContain(after.assets['/icons/icon-96x96.png']);
      expect(content).not.toContain(before.assets['/icons/icon-96x96.png']);
    }
    const manifest = JSON.parse(read('public/manifest.json'));
    expect(manifest).toMatchObject({
      id: '/daedalus-v2',
      start_url: '/',
      scope: '/',
    });
    expect(manifest.shortcuts[0].icons[0].src).toEqual(
      after.assets['/icons/icon-96x96.png'],
    );
  });

  it('versions manifest metadata changes without changing the PNG URLs', () => {
    const { root, read, write } = fixture();
    const before = generateBranding(root);
    const manifest = JSON.parse(read('public/manifest.json'));
    manifest.name = 'Updated name';
    write('public/manifest.json', JSON.stringify(manifest, null, 2));
    const after = generateBranding(root);
    expect(after.assets).toEqual(before.assets);
    expect(after.manifest).not.toEqual(before.manifest);
    write('public/manifest.json', JSON.stringify(manifest));
    expect(generateBranding(root)).toEqual(after);
  });

  it('fails the build when a manifest icon is missing', () => {
    const { root } = fixture();
    rmSync(join(root, 'public/icons/icon-96x96.png'));
    expect(() => generateBranding(root)).toThrow('missing branding asset');
  });
});
