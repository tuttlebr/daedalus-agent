declare module 'heic-decode' {
  interface DecodeOptions {
    buffer: Buffer;
  }

  interface DecodedHeicImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  function decode(options: DecodeOptions): Promise<DecodedHeicImage>;

  export = decode;
}
