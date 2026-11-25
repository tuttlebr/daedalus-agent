export interface MaterialPaint {
  kind: 'wash' | 'reflection';
  width: number;
  height: number;
  edge: number;
  base: number[];
  start: number[];
  end: number[];
  startOpacity: number;
  endOpacity: number;
  tintOpacity: number;
}

// Rank adjacent device pixels in an 8 × 8 Bayer matrix. Sharing one
// threshold across RGB keeps the dither neutral and stable between paints.
// prettier-ignore
const ranks = [
   0, 48, 12, 60,  3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
   8, 56,  4, 52, 11, 59,  7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
   2, 50, 14, 62,  1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58,  6, 54,  9, 57,  5, 53,
  42, 26, 38, 22, 41, 25, 37, 21,
].map((rank) => (rank + 0.5) / 64);

self.onmessage = ({ data }: MessageEvent<MaterialPaint>) => {
  const { kind, width, height, base, start, end, startOpacity, endOpacity } =
    data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const radius = 0.55 * Math.SQRT2;
  const startDelta = start.map((channel, i) => channel - base[i]);
  const endDelta = end.map((channel, i) => channel - base[i]);

  for (let y = 0, offset = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const fade = Math.min(1, y / data.edge, (height - 1 - y) / data.edge);
    for (let x = 0; x < width; x++, offset += 4) {
      let startWeight, endWeight;
      let alpha = 255;
      if (kind === 'wash') {
        const u = (x + 0.5) / width;
        const cool =
          startOpacity * Math.max(0, 1 - Math.sqrt(u * u + v * v) / radius);
        const warm =
          endOpacity *
          Math.max(0, 1 - Math.sqrt((1 - u) ** 2 + (1 - v) ** 2) / radius);
        startWeight = fade * cool;
        endWeight = fade * (1 - cool) * warm;
      } else {
        // Distance along the panel's 135-degree reflection, in its own bounds.
        const t = (x + y + 1) / (width + height);
        startWeight = startOpacity * Math.max(0, 1 - t / 0.45);
        endWeight = endOpacity * Math.max(0, (t - 0.45) / 0.55);
        alpha = Math.round(
          255 *
            (data.tintOpacity +
              (1 - data.tintOpacity) * (startWeight + endWeight)),
        );
      }
      const threshold = ranks[(y & 7) * 8 + (x & 7)];
      for (let c = 0; c < 3; c++) {
        // Canvas composites premultiplied channels. Dither in that space,
        // then encode straight RGBA for ImageData so translucent glass keeps
        // the same sub-level precision over the blurred backdrop.
        const channel =
          base[c] * (alpha / 255) +
          startWeight * startDelta[c] +
          endWeight * endDelta[c];
        pixels[offset + c] = Math.floor(channel + threshold) * (255 / alpha);
      }
      pixels[offset + 3] = alpha;
    }
  }
  self.postMessage(pixels.buffer, { transfer: [pixels.buffer] });
};
