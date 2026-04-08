import { defaultSchema } from 'rehype-sanitize';

/**
 * Custom sanitization schema for Markdown rendering.
 * Extends the default GitHub-style schema to whitelist elements
 * needed by KaTeX, GFM, and our custom components while blocking XSS vectors.
 */
export const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    // KaTeX elements
    'math',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'ms',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'mroot',
    'msqrt',
    'mtable',
    'mtr',
    'mtd',
    'mover',
    'munder',
    'munderover',
    'menclose',
    'mphantom',
    'mpadded',
    'annotation',
    'annotation-xml',
    // Media
    'img',
    'video',
    'source',
    // GFM / HTML extensions
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'details',
    'summary',
    'figure',
    'figcaption',
    // KaTeX wrapper elements
    'span',
    'div',
    // Custom visualization elements
    'chart',
    'searchresults',
    // Semantic sectioning elements
    'section',
    'article',
    'aside',
    'nav',
    'header',
    'footer',
    'main',
    'address',
    // Text-level semantic elements (not in default schema)
    'u',
    'bdi',
    'data',
    'output',
    // Interactive / presentational
    'progress',
    'meter',
    // Table enhancements
    'col',
    'colgroup',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [
      ...(defaultSchema.attributes?.['*'] || []),
      'className',
      'class',
      'style',
      'aria-hidden',
      'role',
    ],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    video: [
      'src',
      'controls',
      'controlsList',
      'preload',
      'poster',
      'width',
      'height',
      'muted',
      'loop',
      'playsinline',
    ],
    source: ['src', 'type'],
    td: ['align', 'valign', 'colSpan', 'rowSpan'],
    th: ['align', 'valign', 'colSpan', 'rowSpan', 'scope'],
    a: ['href', 'title', 'target', 'rel'],
    span: ['className', 'class', 'style', 'aria-hidden'],
    div: ['className', 'class', 'style', 'aria-hidden'],
    math: ['xmlns', 'display'],
    annotation: ['encoding'],
    'annotation-xml': ['encoding'],
    time: ['datetime'],
    abbr: ['title'],
    data: ['value'],
    progress: ['value', 'max'],
    meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
    col: ['span'],
    colgroup: ['span'],
    q: ['cite'],
    bdo: ['dir'],
    output: ['for', 'name'],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Remove 'src' restriction to allow relative URLs (e.g. /api/session/imageStorage)
    // plus data: URIs. Dangerous elements are blocked by the strip list.
    src: undefined as any,
    href: ['http', 'https', 'mailto'],
  },
  // Strip dangerous elements entirely
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button'],
};
