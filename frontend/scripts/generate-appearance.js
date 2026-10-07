#!/usr/bin/env node
// Embed shared color tokens so offline recovery needs no stylesheet request.
const fs = require('node:fs');
const path = require('node:path');
const prettier = require('prettier');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(
  path.join(root, 'styles/appearance.css'),
  'utf8',
);
const marker = '/* END THEME TOKENS */';
if (!source.includes(marker)) throw new Error('Missing theme token boundary');
const tokens = source.slice(0, source.indexOf(marker)).trim();
const file = path.join(root, 'public/offline.html');
const before = fs.readFileSync(file, 'utf8');
const region =
  /      \/\* BEGIN GENERATED APPEARANCE \*\/[\s\S]*?      \/\* END GENERATED APPEARANCE \*\//;
if (!region.test(before)) throw new Error('Missing offline appearance markers');
const after = before.replace(
  region,
  `      /* BEGIN GENERATED APPEARANCE */\n${tokens
    .split('\n')
    .map((line) => (line ? `      ${line}` : ''))
    .join('\n')}\n      /* END GENERATED APPEARANCE */`,
);
const formatted = prettier.format(after, {
  ...prettier.resolveConfig.sync(file),
  filepath: file,
});
if (before !== formatted) fs.writeFileSync(file, formatted);
