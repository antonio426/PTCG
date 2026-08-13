import type { TurnAction } from '@ptcg/shared';

function download(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function exportTurnLogAsJson(turnLog: TurnAction[]) {
  download(`battle-log-${timestampSuffix()}.json`, JSON.stringify(turnLog, null, 2), 'application/json');
}

export function exportTurnLogAsText(turnLog: TurnAction[]) {
  const lines = turnLog.map(entry => {
    const player = entry.player === 0 ? '你' : '對手';
    let line = `[第${entry.turn}回合][${player}] ${entry.details}`;
    if (entry.damageDetail) {
      const d = entry.damageDetail;
      line += `（基礎傷害 ${d.baseDamage} → 最終傷害 ${d.finalDamage}，弱點:${d.weaknessApplied ? '是' : '否'}，抵抗力:${d.resistanceApplied ? '是' : '否'}）`;
    }
    if (entry.coinFlipNote) line += `（擲硬幣：${entry.coinFlipNote}）`;
    return line;
  });
  download(`battle-log-${timestampSuffix()}.txt`, lines.join('\n'), 'text/plain');
}
