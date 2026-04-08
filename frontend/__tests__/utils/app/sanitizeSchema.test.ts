import { describe, it, expect } from 'vitest';
import { sanitizeSchema } from '@/utils/app/sanitizeSchema';

describe('sanitizeSchema', () => {
  const tags = sanitizeSchema.tagNames ?? [];

  describe('KaTeX elements', () => {
    const katexTags = [
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
    ];

    it.each(katexTags)('includes KaTeX element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('media elements', () => {
    it.each(['img', 'video', 'source'])('includes media element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('GFM elements', () => {
    const gfmTags = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'details', 'summary'];

    it.each(gfmTags)('includes GFM element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('KaTeX wrapper elements', () => {
    it.each(['span', 'div'])('includes wrapper element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('semantic sectioning elements', () => {
    const sectioningTags = [
      'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'address',
    ];

    it.each(sectioningTags)('includes sectioning element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('additional text-level elements', () => {
    it.each(['u', 'bdi', 'data', 'output'])('includes text-level element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('interactive/presentational elements', () => {
    it.each(['progress', 'meter'])('includes element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('table enhancement elements', () => {
    it.each(['col', 'colgroup'])('includes table element <%s>', (tag) => {
      expect(tags).toContain(tag);
    });
  });

  describe('dangerous elements are stripped', () => {
    const stripped = sanitizeSchema.strip ?? [];
    const dangerous = ['script', 'style', 'iframe', 'object', 'embed', 'form'];

    it.each(dangerous)('strips dangerous element <%s>', (tag) => {
      expect(stripped).toContain(tag);
    });

    it('also strips input, textarea, and button', () => {
      expect(stripped).toContain('input');
      expect(stripped).toContain('textarea');
      expect(stripped).toContain('button');
    });

    it('does not include stripped elements in tagNames', () => {
      for (const tag of dangerous) {
        expect(tags).not.toContain(tag);
      }
    });
  });

  describe('safe attributes', () => {
    const globalAttrs = sanitizeSchema.attributes?.['*'] ?? [];

    it('allows className on all elements', () => {
      expect(globalAttrs).toContain('className');
    });

    it('allows class on all elements', () => {
      expect(globalAttrs).toContain('class');
    });

    it('allows style on all elements', () => {
      expect(globalAttrs).toContain('style');
    });

    it('allows aria-hidden on all elements', () => {
      expect(globalAttrs).toContain('aria-hidden');
    });

    it('allows role on all elements', () => {
      expect(globalAttrs).toContain('role');
    });

    it('allows src, alt, title, width, height, loading on img', () => {
      const imgAttrs = sanitizeSchema.attributes?.img ?? [];
      expect(imgAttrs).toEqual(expect.arrayContaining(['src', 'alt', 'title', 'width', 'height', 'loading']));
    });

    it('allows media attributes on video', () => {
      const videoAttrs = sanitizeSchema.attributes?.video ?? [];
      expect(videoAttrs).toEqual(
        expect.arrayContaining(['src', 'controls', 'controlsList', 'preload', 'poster', 'width', 'height', 'muted', 'loop', 'playsinline']),
      );
    });

    it('allows src and type on source', () => {
      const sourceAttrs = sanitizeSchema.attributes?.source ?? [];
      expect(sourceAttrs).toEqual(expect.arrayContaining(['src', 'type']));
    });

    it('allows href, title, target, rel on anchor', () => {
      const aAttrs = sanitizeSchema.attributes?.a ?? [];
      expect(aAttrs).toEqual(expect.arrayContaining(['href', 'title', 'target', 'rel']));
    });

    it('allows table cell attributes on td and th', () => {
      const tdAttrs = sanitizeSchema.attributes?.td ?? [];
      const thAttrs = sanitizeSchema.attributes?.th ?? [];
      expect(tdAttrs).toEqual(expect.arrayContaining(['align', 'valign', 'colSpan', 'rowSpan']));
      expect(thAttrs).toEqual(expect.arrayContaining(['align', 'valign', 'colSpan', 'rowSpan', 'scope']));
    });

    it('allows xmlns and display on math', () => {
      const mathAttrs = sanitizeSchema.attributes?.math ?? [];
      expect(mathAttrs).toEqual(expect.arrayContaining(['xmlns', 'display']));
    });

    it('allows encoding on annotation and annotation-xml', () => {
      const annotationAttrs = sanitizeSchema.attributes?.annotation ?? [];
      const annotationXmlAttrs = sanitizeSchema.attributes?.['annotation-xml'] ?? [];
      expect(annotationAttrs).toContain('encoding');
      expect(annotationXmlAttrs).toContain('encoding');
    });

    it('allows datetime on time', () => {
      const timeAttrs = sanitizeSchema.attributes?.time ?? [];
      expect(timeAttrs).toContain('datetime');
    });

    it('allows title on abbr', () => {
      const abbrAttrs = sanitizeSchema.attributes?.abbr ?? [];
      expect(abbrAttrs).toContain('title');
    });

    it('allows value on data', () => {
      const dataAttrs = sanitizeSchema.attributes?.data ?? [];
      expect(dataAttrs).toContain('value');
    });

    it('allows value and max on progress', () => {
      const progressAttrs = sanitizeSchema.attributes?.progress ?? [];
      expect(progressAttrs).toEqual(expect.arrayContaining(['value', 'max']));
    });

    it('allows value, min, max, low, high, optimum on meter', () => {
      const meterAttrs = sanitizeSchema.attributes?.meter ?? [];
      expect(meterAttrs).toEqual(expect.arrayContaining(['value', 'min', 'max', 'low', 'high', 'optimum']));
    });

    it('allows span on col and colgroup', () => {
      const colAttrs = sanitizeSchema.attributes?.col ?? [];
      const colgroupAttrs = sanitizeSchema.attributes?.colgroup ?? [];
      expect(colAttrs).toContain('span');
      expect(colgroupAttrs).toContain('span');
    });

    it('allows cite on q', () => {
      const qAttrs = sanitizeSchema.attributes?.q ?? [];
      expect(qAttrs).toContain('cite');
    });

    it('allows dir on bdo', () => {
      const bdoAttrs = sanitizeSchema.attributes?.bdo ?? [];
      expect(bdoAttrs).toContain('dir');
    });

    it('allows for and name on output', () => {
      const outputAttrs = sanitizeSchema.attributes?.output ?? [];
      expect(outputAttrs).toEqual(expect.arrayContaining(['for', 'name']));
    });
  });

  describe('safe protocols', () => {
    it('does not restrict src protocols (allows relative URLs for /api/session/imageStorage)', () => {
      // src protocols are intentionally NOT defined so that relative URLs pass through.
      // When protocols.src is undefined, hast-util-sanitize allows all URLs for src.
      expect(sanitizeSchema.protocols?.src).toBeUndefined();
    });

    it('allows http, https, and mailto for href', () => {
      const hrefProtocols = sanitizeSchema.protocols?.href ?? [];
      expect(hrefProtocols).toContain('http');
      expect(hrefProtocols).toContain('https');
      expect(hrefProtocols).toContain('mailto');
    });

    it('does not allow javascript protocol for href', () => {
      const hrefProtocols = sanitizeSchema.protocols?.href ?? [];
      expect(hrefProtocols).not.toContain('javascript');
    });

    it('src protocols are unrestricted (allows relative URLs, data:, etc.)', () => {
      // src is intentionally not in protocols to allow relative URLs
      expect(sanitizeSchema.protocols?.src).toBeUndefined();
    });
  });

  describe('schema structure', () => {
    it('extends defaultSchema (has tagNames, attributes, protocols, strip)', () => {
      expect(sanitizeSchema.tagNames).toBeDefined();
      expect(sanitizeSchema.attributes).toBeDefined();
      expect(sanitizeSchema.protocols).toBeDefined();
      expect(sanitizeSchema.strip).toBeDefined();
    });

    it('tagNames is an array', () => {
      expect(Array.isArray(sanitizeSchema.tagNames)).toBe(true);
    });
  });
});
