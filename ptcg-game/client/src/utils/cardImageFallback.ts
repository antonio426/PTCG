import type { SyntheticEvent } from 'react';

/* Card art fallback. Most load failures observed in practice are transient
 * (a dev-server hot-reload or a slow first-time CDN fetch dropping the
 * in-flight request, not a bad URL — every URL that's actually failed for a
 * user has round-tripped fine on retry) rather than "this card truly has no
 * artwork". So retry once with a cache-busting query param before giving up;
 * only cards that still fail after the retry fall back to the placeholder. */

export const CARD_IMAGE_FALLBACK = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">' +
  '<rect width="100" height="140" rx="8" fill="#1e293b"/>' +
  '<rect x="4" y="4" width="92" height="132" rx="6" fill="none" stroke="#475569" stroke-width="2" stroke-dasharray="5 5"/>' +
  '<text x="50" y="80" font-size="40" fill="#64748b" text-anchor="middle" font-family="sans-serif">?</text>' +
  '</svg>'
);

export function handleCardImgError(e: SyntheticEvent<HTMLImageElement>) {
  const img = e.currentTarget;

  if (!img.dataset.imgRetried) {
    img.dataset.imgRetried = '1';
    const base = img.src.split('?')[0];
    window.setTimeout(() => { img.src = `${base}?retry=${Date.now()}`; }, 500);
    return;
  }

  img.onerror = null; // avoid a loop if the fallback data URI itself somehow fails to render
  img.src = CARD_IMAGE_FALLBACK;
}
