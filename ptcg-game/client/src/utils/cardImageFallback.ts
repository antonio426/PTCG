import type { SyntheticEvent } from 'react';

/* Card art fallback — some cards in the dataset have no artwork hosted    */
/* on TCGdex at all (confirmed live: the CDN 404s for both size variants   */
/* and the card's own detail response has no `image` field), not a URL-   */
/* construction bug on our side. Swap to a placeholder instead of         */
/* leaving the browser's broken-image icon on screen.                     */

export const CARD_IMAGE_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">' +
  '<rect width="100" height="140" rx="8" fill="#1e293b"/>' +
  '<rect x="4" y="4" width="92" height="132" rx="6" fill="none" stroke="#475569" stroke-width="2" stroke-dasharray="5 5"/>' +
  '<text x="50" y="80" font-size="40" fill="#64748b" text-anchor="middle" font-family="sans-serif">?</text>' +
  '</svg>'
);

export function handleCardImgError(e: SyntheticEvent<HTMLImageElement>) {
  const img = e.currentTarget;
  img.onerror = null; // avoid a loop if the fallback data URI itself somehow fails to render
  img.src = CARD_IMAGE_FALLBACK;
}
