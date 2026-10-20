#!/usr/bin/env node
/**
 * Post-build script: reads the Next.js build manifest and writes the critical
 * JS/CSS chunk paths to public/precache-manifest.json, which the service
 * worker precaches on install (enabling true offline-first PWA).
 *
 * Run after `next build` via: node scripts/inject-precache.js
 */
const fs = require('fs');
const path = require('path');

const BUILD_MANIFEST = path.join(
  __dirname,
  '..',
  '.next',
  'build-manifest.json',
);
const MANIFEST_PATH = path.join(
  __dirname,
  '..',
  'public',
  'precache-manifest.json',
);

function run() {
  if (!fs.existsSync(BUILD_MANIFEST)) {
    console.warn(
      '[inject-precache] No .next/build-manifest.json found — skipping.',
    );
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(BUILD_MANIFEST, 'utf8'));

  // Collect critical page chunks: shared entrypoints + the main pages
  const urls = new Set();

  // Shared chunks loaded on every page
  for (const file of manifest.pages['/_app'] || []) {
    urls.add('/_next/' + file);
  }

  // Home page chunks
  for (const file of manifest.pages['/'] || []) {
    urls.add('/_next/' + file);
  }

  // Login page (so offline login page works if cached)
  for (const file of manifest.pages['/login'] || []) {
    urls.add('/_next/' + file);
  }

  if (urls.size === 0) {
    console.warn(
      '[inject-precache] No chunks found in build manifest — skipping.',
    );
    return;
  }

  // The service worker fetches this list at install (public/sw.js), so the
  // build never rewrites a tracked source file.
  fs.writeFileSync(
    MANIFEST_PATH,
    JSON.stringify([...urls], null, 2) + '\n',
    'utf8',
  );
  console.log(
    `[inject-precache] Wrote ${urls.size} chunk URLs to public/precache-manifest.json`,
  );
}

run();
