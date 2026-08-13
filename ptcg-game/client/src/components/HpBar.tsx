export default function HpBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  const color = pct > 50 ? 'from-green-400 to-green-600' : pct > 20 ? 'from-yellow-400 to-yellow-600' : 'from-red-400 to-red-600';
  return (
    <div className="w-full bg-black/40 rounded-full h-2.5 overflow-hidden border border-black/30 shadow-inner">
      <div
        className={`h-full bg-gradient-to-b ${color} transition-all duration-500 ease-out rounded-full`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
