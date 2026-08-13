import type { ReactNode } from 'react';

/** Small always-visible stat tile (deck-remaining / discard-count, etc.) — icon-ish label on top,
 * big number below, per the ptcg-tw-sim.com reference's flanking stat boxes. */
export default function StatBox({ value, label, icon, onClick, colorClassName = 'bg-sky-900/60 border-sky-700/60 text-sky-100' }: {
  value: number;
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  colorClassName?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={`flex flex-col items-center justify-center w-14 h-14 rounded-lg border shadow-inner leading-none ${colorClassName} ${onClick ? 'hover:brightness-110 transition-all cursor-pointer' : ''}`}
    >
      {icon}
      <span className="text-lg font-bold tabular-nums">{value}</span>
      <span className="text-[9px] opacity-80 mt-0.5">{label}</span>
    </Tag>
  );
}
