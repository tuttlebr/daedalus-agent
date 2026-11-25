import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import sharp from 'sharp';

// Regenerate the static wash when the Alaska palette or dark tint changes.
const css = postcss.parse(
  await readFile(new URL('../styles/appearance.css', import.meta.url), 'utf8'),
);
const palette = css.nodes.find((rule) => rule.selector === ':root');
const dark = css.nodes.find((rule) => rule.selectors?.includes('html.dark'));
const token = (rule, name) =>
  rule.nodes.find((node) => node.prop === name).value;
const rgb = (name) => token(palette, name).split(/\s+/).map(Number);
const base = rgb(token(dark, '--app').match(/^var\((--[\w-]+)\)$/)[1]);
const cool = rgb('--palette-glacier');
const warm = rgb('--palette-apricot');
const strength = Number(token(dark, '--canvas-wash'));

const width = 1920;
const height = 1080;
const edge = 128; // These rows become the 8rem border-image slices in CSS.
const radius = 0.55 * Math.SQRT2; // 55% of the farthest-corner ellipse.
const pixels = Buffer.alloc(width * height * 3);

// An ordered dither distributes adjacent shades locally and compresses well.
// Use the same threshold for all three channels to keep the texture neutral.
// prettier-ignore
const bayer = [
  [ 0, 48, 12, 60,  3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [ 8, 56,  4, 52, 11, 59,  7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [ 2, 50, 14, 62,  1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58,  6, 54,  9, 57,  5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21],
];

for (let y = 0; y < height; y++) {
  const v = (y + 0.5) / height;
  const fade = Math.min(1, y / edge, (height - 1 - y) / edge);
  for (let x = 0; x < width; x++) {
    const u = (x + 0.5) / width;
    const coolAlpha = strength * Math.max(0, 1 - Math.hypot(u, v) / radius);
    const warmAlpha =
      strength * Math.max(0, 1 - Math.hypot(1 - u, 1 - v) / radius);
    const threshold = (bayer[y % 8][x % 8] + 0.5) / 64;
    for (let c = 0; c < 3; c++) {
      const under = warmAlpha * (warm[c] - base[c]);
      const wash = coolAlpha * (cool[c] - base[c]) + (1 - coolAlpha) * under;
      pixels[(y * width + x) * 3 + c] = Math.floor(
        base[c] + fade * wash + threshold,
      );
    }
  }
}

await sharp(pixels, { raw: { width, height, channels: 3 } })
  .png({ palette: true, dither: 0, compressionLevel: 9, effort: 10 })
  .toFile(fileURLToPath(new URL('../styles/dark-canvas.png', import.meta.url)));
