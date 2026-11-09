import type { Outcome } from '@/types/autonomy';

/** Keep legacy results readable without exposing their diagnostic fields. New
 * results are validated at publication; this also bounds old/cached responses. */
export function shortText(text: string, words = 80, characters = 600): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (plain.length <= characters && plain.split(/\s+/).length <= words)
    return plain;
  const parts = plain.split(/\s+/).slice(0, words);
  while (parts.length && parts.join(' ').length > characters - 1) parts.pop();
  return parts.join(' ').replace(/[,:;.]$/, '') + '…';
}
function firstSentence(text: string): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const segments = new Intl.Segmenter('en', {
    granularity: 'sentence',
  }).segment(plain);
  return segments[Symbol.iterator]().next().value?.segment.trim() || plain;
}
export function outcomeNote(outcome: Outcome): string {
  // Older reports kept the owner's next step in recommendations. Carry just
  // that first step forward, never the audit trail or a list of rejected actions.
  if (
    !outcome.reportVersion &&
    outcome.status !== 'completed' &&
    outcome.recommendations?.[0]
  ) {
    const result = firstSentence(outcome.summary);
    const next = firstSentence(outcome.recommendations[0]);
    if (next && !result.includes(next))
      return shortText(`${shortText(result, 35, 250)} ${next}`);
  }
  return shortText(outcome.summary);
}
