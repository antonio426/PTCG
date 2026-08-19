import type { ReactNode } from 'react';

/** Shared modal shell — dark-felt-gradient panel over a backdrop, with an optional title bar and
 * close button. `backdropClassName` lets callers choose how opaque the backdrop is (e.g. the
 * pending-choice picker wants the board dimly visible behind it, per the ptcg-tw-sim.com
 * reference, rather than a fully opaque black backdrop). Clicking the backdrop itself closes the
 * modal (if `onClose` is given); clicking inside the panel does not. */
export default function Modal({
  title, onClose, children, maxWidthClassName = 'max-w-2xl', backdropClassName = 'bg-black/70',
}: {
  title?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  maxWidthClassName?: string;
  backdropClassName?: string;
}) {
  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${backdropClassName}`}
      onClick={onClose}
    >
      <div
        className={`relative bg-[radial-gradient(ellipse_at_top,theme(colors.battle.felt.from)_0%,theme(colors.battle.felt.via)_60%,theme(colors.battle.felt.to)_100%)] border border-emerald-800/60 ring-1 ring-inset ring-white/10 rounded-2xl p-5 w-full mx-4 max-h-[80vh] overflow-y-auto shadow-2xl shadow-black/60 ${maxWidthClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || onClose) && (
          <div className="flex items-center justify-between mb-3">
            {title && <h3 className="text-white font-semibold flex items-center gap-1.5">{title}</h3>}
            {onClose && (
              <button
                onClick={onClose}
                aria-label="關閉"
                className="w-11 h-11 -m-2 flex items-center justify-center rounded-full text-emerald-500/70 hover:text-emerald-200 hover:bg-white/5 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="m18 6-12 12M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
