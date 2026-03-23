/**
 * LaTeX Normalizer Utility
 *
 * Converts various LaTeX delimiter formats to the format expected by KaTeX
 * Supports:
 * - \[...\] → $$...$$  (display math)
 * - \(...\) → $...$    (inline math)
 * - $$...$$ → $$...$$ (already supported)
 * - $...$ → $...$     (already supported)
 */

/**
 * Normalizes LaTeX delimiters in text to formats supported by KaTeX
 * @param text - The text containing LaTeX expressions
 * @returns Text with normalized LaTeX delimiters
 */
export function normalizeLatexDelimiters(text: string): string {
  if (!text) return text;

  let normalized = text;

  // Convert \[...\] to $$...$$ for display math
  // Use a more robust regex that handles newlines
  normalized = normalized.replace(/\\\[([\s\S]*?)\\\]/g, (match, content) => {
    return `$$${content}$$`;
  });

  // Convert \(...\) to $...$ for inline math
  normalized = normalized.replace(/\\\(([\s\S]*?)\\\)/g, (match, content) => {
    return `$${content}$`;
  });

  // Handle equation environments if present
  normalized = normalized.replace(/\\begin\{equation\}([\s\S]*?)\\end\{equation\}/g, (match, content) => {
    return `$$${content}$$`;
  });

  normalized = normalized.replace(/\\begin\{equation\*\}([\s\S]*?)\\end\{equation\*\}/g, (match, content) => {
    return `$$${content}$$`;
  });

  // Handle align environments
  normalized = normalized.replace(/\\begin\{align\}([\s\S]*?)\\end\{align\}/g, (match, content) => {
    return `$$\\begin{aligned}${content}\\end{aligned}$$`;
  });

  normalized = normalized.replace(/\\begin\{align\*\}([\s\S]*?)\\end\{align\*\}/g, (match, content) => {
    return `$$\\begin{aligned}${content}\\end{aligned}$$`;
  });

  return normalized;
}

/**
 * Checks if a string contains LaTeX expressions
 * @param text - The text to check
 * @returns true if LaTeX expressions are detected
 */
export function containsLatex(text: string): boolean {
  if (!text) return false;

  // Check for various LaTeX delimiters
  const patterns = [
    /\$\$[\s\S]*?\$\$/,        // $$...$$
    /\$[^\$\n]+\$/,             // $...$
    /\\\[[\s\S]*?\\\]/,         // \[...\]
    /\\\([\s\S]*?\\\)/,         // \(...\)
    /\\begin\{equation\*?\}/,   // equation environments
    /\\begin\{align\*?\}/,      // align environments
    /\\frac\{/,                 // \frac command
    /\\sqrt\{/,                 // \sqrt command
    /\\sum/,                    // \sum command
    /\\int/,                    // \int command
  ];

  return patterns.some(pattern => pattern.test(text));
}

/**
 * Safely escapes text that might be confused with LaTeX but isn't
 * @param text - The text to escape
 * @returns Escaped text
 */
export function escapeNonLatex(text: string): string {
  // This would be used if you need to display dollar signs that aren't math
  // For example: "This costs $5" should not be treated as math
  // Currently not used as our config has singleDollarTextMath: false
  return text;
}

/**
 * Extracts LaTeX expressions from text
 * @param text - The text containing LaTeX
 * @returns Array of extracted LaTeX expressions
 */
export function extractLatexExpressions(text: string): string[] {
  const expressions: string[] = [];

  // Extract display math
  const displayMath = text.match(/\$\$([\s\S]*?)\$\$/g);
  if (displayMath) expressions.push(...displayMath);

  const displayMath2 = text.match(/\\\[([\s\S]*?)\\\]/g);
  if (displayMath2) expressions.push(...displayMath2);

  // Extract inline math (but not $$)
  const inlineMath = text.match(/(?<!\$)\$(?!\$)[^\$\n]+\$(?!\$)/g);
  if (inlineMath) expressions.push(...inlineMath);

  const inlineMath2 = text.match(/\\\(([\s\S]*?)\\\)/g);
  if (inlineMath2) expressions.push(...inlineMath2);

  return expressions;
}
