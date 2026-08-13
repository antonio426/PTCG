import type { ReactNode } from 'react';

/** Generic small pill — icon + label with a caller-supplied color className (e.g. status
 * conditions, turn indicators). Doesn't own any color/icon mapping itself; callers decide those. */
export default function Badge({ icon, label, className = 'bg-yellow-900/50 border-yellow-700/50 text-yellow-300' }: {
  icon?: ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-medium ${className}`}>
      {icon}
      {label}
    </span>
  );
}
