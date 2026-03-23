import { generateRandomString, programmingLanguages } from '@/utils/app/codeblock';

import { describe, expect, it } from 'vitest';

describe('generateRandomString', () => {
  it('should generate a string of the correct length', () => {
    expect(generateRandomString(10)).toHaveLength(10);
    expect(generateRandomString(5)).toHaveLength(5);
    expect(generateRandomString(1)).toHaveLength(1);
  });

  it('should return lowercase when lowercase flag is true', () => {
    const result = generateRandomString(20, true);
    expect(result).toBe(result.toLowerCase());
  });

  it('should not contain excluded characters (Z, 2, I, 1, O, 0)', () => {
    // Generate a long string to increase chance of catching excluded chars
    const result = generateRandomString(200);
    expect(result).not.toMatch(/[Z2I1O0]/);
  });

  it('should produce different results on different calls', () => {
    const results = new Set(Array.from({ length: 10 }, () => generateRandomString(10)));
    // With 30 possible chars and length 10, collisions are astronomically unlikely
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('programmingLanguages', () => {
  it('should map javascript to .js', () => {
    expect(programmingLanguages['javascript']).toBe('.js');
  });

  it('should map python to .py', () => {
    expect(programmingLanguages['python']).toBe('.py');
  });

  it('should map typescript to .ts', () => {
    expect(programmingLanguages['typescript']).toBe('.ts');
  });

  it('should map rust to .rs', () => {
    expect(programmingLanguages['rust']).toBe('.rs');
  });

  it('should map go to .go', () => {
    expect(programmingLanguages['go']).toBe('.go');
  });

  it('should return undefined for unknown language', () => {
    expect(programmingLanguages['brainfuck']).toBeUndefined();
  });
});
