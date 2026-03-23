import {
  normalizeLatexDelimiters,
  containsLatex,
  escapeNonLatex,
  extractLatexExpressions,
} from '@/utils/app/latexNormalizer';

import { describe, expect, it } from 'vitest';

describe('normalizeLatexDelimiters', () => {
  it('should convert \\[...\\] to $$...$$', () => {
    expect(normalizeLatexDelimiters('\\[x^2\\]')).toBe('$$x^2$$');
  });

  it('should convert \\(...\\) to $...$', () => {
    expect(normalizeLatexDelimiters('\\(x^2\\)')).toBe('$x^2$');
  });

  it('should convert equation environment to $$...$$', () => {
    const input = '\\begin{equation}x^2\\end{equation}';
    expect(normalizeLatexDelimiters(input)).toBe('$$x^2$$');
  });

  it('should convert equation* environment to $$...$$', () => {
    const input = '\\begin{equation*}x^2\\end{equation*}';
    expect(normalizeLatexDelimiters(input)).toBe('$$x^2$$');
  });

  it('should convert align environment to aligned', () => {
    const input = '\\begin{align}a &= b\\end{align}';
    expect(normalizeLatexDelimiters(input)).toBe('$$\\begin{aligned}a &= b\\end{aligned}$$');
  });

  it('should convert align* environment to aligned', () => {
    const input = '\\begin{align*}a &= b\\end{align*}';
    expect(normalizeLatexDelimiters(input)).toBe('$$\\begin{aligned}a &= b\\end{aligned}$$');
  });

  it('should pass through already-correct $...$ delimiters', () => {
    expect(normalizeLatexDelimiters('$x^2$')).toBe('$x^2$');
  });

  it('should pass through already-correct $$...$$ delimiters', () => {
    expect(normalizeLatexDelimiters('$$x^2$$')).toBe('$$x^2$$');
  });

  it('should return empty string for empty input', () => {
    expect(normalizeLatexDelimiters('')).toBe('');
  });

  it('should return null for null input', () => {
    expect(normalizeLatexDelimiters(null as any)).toBe(null);
  });

  it('should handle multiline content in display math', () => {
    const input = '\\[\nx^2 +\ny^2\n\\]';
    expect(normalizeLatexDelimiters(input)).toBe('$$\nx^2 +\ny^2\n$$');
  });
});

describe('containsLatex', () => {
  it('should detect $$...$$ delimiters', () => {
    expect(containsLatex('text $$x^2$$ more')).toBe(true);
  });

  it('should detect $...$ delimiters', () => {
    expect(containsLatex('text $x^2$ more')).toBe(true);
  });

  it('should detect \\[...\\] delimiters', () => {
    expect(containsLatex('text \\[x^2\\] more')).toBe(true);
  });

  it('should detect \\(...\\) delimiters', () => {
    expect(containsLatex('text \\(x^2\\) more')).toBe(true);
  });

  it('should detect \\frac command', () => {
    expect(containsLatex('\\frac{1}{2}')).toBe(true);
  });

  it('should detect \\sqrt command', () => {
    expect(containsLatex('\\sqrt{4}')).toBe(true);
  });

  it('should detect \\sum command', () => {
    expect(containsLatex('\\sum_{i=0}')).toBe(true);
  });

  it('should detect \\int command', () => {
    expect(containsLatex('\\int_0^1')).toBe(true);
  });

  it('should return false for plain text', () => {
    expect(containsLatex('just plain text')).toBe(false);
  });

  it('should return false for empty input', () => {
    expect(containsLatex('')).toBe(false);
  });

  it('should return false for null input', () => {
    expect(containsLatex(null as any)).toBe(false);
  });
});

describe('escapeNonLatex', () => {
  it('should return text unchanged (identity function)', () => {
    const input = 'This costs $5 and that costs $10';
    expect(escapeNonLatex(input)).toBe(input);
  });
});

describe('extractLatexExpressions', () => {
  it('should extract $$...$$ display math', () => {
    const result = extractLatexExpressions('text $$x^2$$ more');
    expect(result).toContain('$$x^2$$');
  });

  it('should extract \\[...\\] display math', () => {
    const result = extractLatexExpressions('text \\[x^2\\] more');
    expect(result).toContain('\\[x^2\\]');
  });

  it('should extract $...$ inline math', () => {
    const result = extractLatexExpressions('text $x^2$ more');
    expect(result).toContain('$x^2$');
  });

  it('should extract \\(...\\) inline math', () => {
    const result = extractLatexExpressions('text \\(x^2\\) more');
    expect(result).toContain('\\(x^2\\)');
  });

  it('should extract multiple expressions', () => {
    const result = extractLatexExpressions('$$a$$ and $b$ and \\[c\\]');
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  it('should return empty array for no math', () => {
    expect(extractLatexExpressions('no math here')).toEqual([]);
  });
});
