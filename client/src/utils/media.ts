/**
 * Media types the browser can safely render as passive images.
 *
 * SVG is deliberately excluded: an SVG document can contain script and is
 * served as a download by the server. Keeping the client list in sync avoids
 * requesting it into an <img> tag that will never render.
 */
const INLINE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

export function isInlineImageMime(mimeType: string | undefined | null): boolean {
  if (typeof mimeType !== 'string') return false;
  const normalized = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return INLINE_IMAGE_TYPES.has(normalized);
}
