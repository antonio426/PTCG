import type { ReactNode } from 'react';
import type { Card } from '@ptcg/shared';
import { handleCardImgError } from '../utils/cardImageFallback';

const ENERGY_COLORS: Record<string, string> = {
  Grass: 'bg-green-500', Fire: 'bg-red-500', Water: 'bg-blue-500',
  Lightning: 'bg-yellow-400', Psychic: 'bg-purple-500', Fighting: 'bg-orange-600',
  Darkness: 'bg-stone-800', Metal: 'bg-slate-400', Dragon: 'bg-indigo-500',
  Fairy: 'bg-pink-400', Colorless: 'bg-gray-400',
};
const ENERGY_LABELS: Record<string, string> = {
  Grass: '草', Fire: '炎', Water: '水', Lightning: '雷',
  Psychic: '超', Fighting: '闘', Darkness: '悪', Metal: '鋼',
  Dragon: '竜', Fairy: '妖', Colorless: '無',
};

function EnergyIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]';
  return (
    <span className={`inline-flex items-center justify-center rounded-full ${ENERGY_COLORS[type] || 'bg-gray-500'} text-white font-bold ${cls}`}>
      {ENERGY_LABELS[type] || '?'}
    </span>
  );
}

const ABILITY_TYPE_LABELS: Record<string, string> = {
  Ability: '特性', 'Pokémon-Power': '寶可夢力量', 'Poké-Body': '寶可夢身體', 'Poké-Power': '寶可夢力量',
};

interface CardArtDetailProps {
  card: Card;
  variant: 'compact' | 'full';
  /** Only passed from the Battle page — current in-play HP/status, shown as an extra box. */
  battleStatus?: { currentHp: number; maxHp: number; statusNode?: ReactNode };
}

/** Shared "real card art + structured text" detail view — `compact` for hover previews
 * (Battle.tsx, DeckBuilder.tsx), `full` for a standalone modal (CardBrowser.tsx, Battle.tsx's
 * click-through detail). Both variants render the same underlying data, just at different sizes. */
export default function CardArtDetail({ card, variant, battleStatus }: CardArtDetailProps) {
  const isFull = variant === 'full';
  const hasWRR = (card.weaknesses?.length || card.resistances?.length || (card.retreatCost?.length ?? 0) > 0);

  return (
    <div className={isFull ? 'flex flex-col md:flex-row gap-6' : 'w-72'}>
      <div className={isFull ? 'flex-shrink-0 flex justify-center' : 'flex gap-3 mb-2'}>
        <img
          src={(isFull ? card.images.large : card.images.large || card.images.small)}
          alt={card.name}
          onError={handleCardImgError}
          className={isFull
            ? 'w-64 h-auto max-h-96 object-contain rounded-lg shadow-lg'
            : 'w-20 h-auto rounded-lg object-contain bg-slate-800 flex-shrink-0 border border-slate-700'}
        />
        {!isFull && (
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-white leading-tight">{card.name}</p>
            <p className="text-[10px] text-slate-400 mt-0.5">
              {card.supertype}{card.subtypes?.length ? ` · ${card.subtypes.join(' / ')}` : ''}
            </p>
            {card.evolvesFrom && <p className="text-[10px] text-slate-500 mt-0.5">進化自：{card.evolvesFrom}</p>}
            {card.hp && (
              <div className="flex items-center gap-1 mt-1.5">
                <span className="text-xs text-slate-300 font-medium">HP {card.hp}</span>
                {card.types?.map((t, i) => <EnergyIcon key={i} type={t} />)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={isFull ? 'flex-1 space-y-4' : ''}>
        {isFull && (
          <div>
            <h2 className="text-2xl font-bold text-white">{card.name}</h2>
            <p className="text-slate-400 text-sm">
              {card.supertype} {card.subtypes?.join(' / ')}
              {card.evolvesFrom && <span> · 進化自：{card.evolvesFrom}</span>}
            </p>
            {card.hp && (
              <div className="flex items-center gap-2 mt-2">
                <span className="text-lg font-bold text-red-400">HP {card.hp}</span>
                {card.types?.map((t, i) => <EnergyIcon key={i} type={t} size="md" />)}
              </div>
            )}
          </div>
        )}

        {battleStatus && (
          <div className="flex items-center gap-2 bg-black/30 border border-emerald-800/50 rounded-lg px-2.5 py-1.5">
            <span className="text-xs text-emerald-300 font-medium">場上狀態：{battleStatus.currentHp}/{battleStatus.maxHp} HP</span>
            {battleStatus.statusNode}
          </div>
        )}

        {card.rules?.map((r, i) => (
          <p key={i} className={isFull ? 'text-slate-400 text-sm italic' : 'text-[11px] text-slate-200 leading-snug mb-1.5'}>{r}</p>
        ))}

        {card.abilities?.filter(a => a.text).map((a, i) => (
          <div key={i} className={isFull ? 'bg-slate-700/50 rounded-lg p-3 border-l-4 border-yellow-500' : 'mb-1.5 bg-emerald-950/40 border border-emerald-800/50 rounded-lg px-2 py-1.5'}>
            <p className={isFull ? 'text-yellow-400 font-semibold text-sm' : 'text-[11px] font-semibold text-emerald-400'}>
              {ABILITY_TYPE_LABELS[a.type] || a.type}：{a.name}
            </p>
            <p className={isFull ? 'text-slate-300 text-sm' : 'text-[11px] text-slate-300 leading-snug mt-0.5'}>{a.text}</p>
          </div>
        ))}

        {card.attacks && card.attacks.length > 0 && (
          <div className={isFull ? 'space-y-2' : ''}>
            {isFull && <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wide">招式</h3>}
            {card.attacks.map((atk, i) => (
              <div key={i} className={isFull ? 'bg-slate-700/30 rounded-lg p-3' : 'mb-1.5'}>
                <div className={isFull ? 'flex items-center justify-between mb-1' : 'flex items-center gap-1 flex-wrap'}>
                  <div className={isFull ? 'flex items-center gap-2' : 'flex items-center gap-1 flex-wrap'}>
                    {atk.cost.map((c, ci) => <EnergyIcon key={ci} type={c} />)}
                    <span className={isFull ? 'text-white font-medium' : 'text-xs font-semibold text-white ml-1'}>{atk.name}</span>
                  </div>
                  {atk.damage && <span className={isFull ? 'text-lg font-bold text-slate-100' : 'text-xs text-red-400 ml-auto font-bold'}>{atk.damage}</span>}
                </div>
                {atk.text && <p className={isFull ? 'text-slate-400 text-xs' : 'text-[11px] text-slate-400 leading-snug mt-0.5'}>{atk.text}</p>}
              </div>
            ))}
          </div>
        )}

        {isFull ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            {card.weaknesses && card.weaknesses.length > 0 && (
              <div>
                <span className="text-slate-500">弱點</span>
                <div className="flex gap-1 mt-1">
                  {card.weaknesses.map((w, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <EnergyIcon type={w.type} /> <span className="text-slate-300">{w.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {card.resistances && card.resistances.length > 0 && (
              <div>
                <span className="text-slate-500">抵抗力</span>
                <div className="flex gap-1 mt-1">
                  {card.resistances.map((r, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <EnergyIcon type={r.type} /> <span className="text-slate-300">{r.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : hasWRR && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-400 mt-2 pt-2 border-t border-slate-700">
            {card.weaknesses?.map((w, i) => (
              <span key={i}>弱點 <EnergyIcon type={w.type} />{w.value}</span>
            ))}
            {card.resistances?.map((r, i) => (
              <span key={i}>抵抗 <EnergyIcon type={r.type} />{r.value}</span>
            ))}
            {(card.retreatCost?.length ?? 0) > 0 && (
              <span className="flex items-center gap-1">撤退 {card.retreatCost!.map((_, i) => <EnergyIcon key={i} type="Colorless" />)}</span>
            )}
          </div>
        )}

        {isFull && card.retreatCost && card.retreatCost.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-slate-500 text-sm">撤退費用</span>
            <div className="flex gap-0.5">
              {card.retreatCost.map((c, i) => <EnergyIcon key={i} type={c} />)}
            </div>
          </div>
        )}

        {!isFull && card.flavorText && (
          <p className="text-[10px] text-slate-500 italic leading-snug mt-2 pt-2 border-t border-slate-700">{card.flavorText}</p>
        )}

        {isFull && (
          <div className="pt-2 border-t border-slate-700 text-xs text-slate-500 space-y-1">
            <p>編號: {card.set.id} - {card.number}</p>
            <p>系列: {card.set.series} / {card.set.name}</p>
            {card.rarity && <p>稀有度: {card.rarity}</p>}
            {card.artist && <p>繪師: {card.artist}</p>}
            <div className="flex gap-3 mt-1">
              {card.legalities.standard && <span className={card.legalities.standard === 'Legal' ? 'text-green-400' : 'text-red-400'}>標準: {card.legalities.standard}</span>}
              {card.legalities.expanded && <span className={card.legalities.expanded === 'Legal' ? 'text-green-400' : 'text-red-400'}>擴充: {card.legalities.expanded}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
