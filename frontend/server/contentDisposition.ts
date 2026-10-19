/** Keep HTTP headers ASCII while preserving the download name in filename*. */
export function buildContentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback =
    filename.replace(/[^\x20-\x7e]|["\\/]/g, '_').slice(0, 200) || 'document';
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
