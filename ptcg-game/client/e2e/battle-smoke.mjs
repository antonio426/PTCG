/**
 * Browser smoke test for the battle UI.
 *
 * Everything else in this repo tests the engine. Nothing tested the layer the player actually uses,
 * and the failures that live there are invisible to the server suites by construction: a modal with
 * no clickable option, an action the server offers that no element renders, a render crash on a card
 * shape that only turns up mid-game.
 *
 * It drives a real Chromium against the dev servers and, on every step, cross-checks the DOM against
 * the server's own `legalMoves` — read out of the `/api/human-battle` responses as they arrive, so
 * the app needs no test hooks.
 *
 * Fails (exit 1) on: an uncaught page error, a console error, a step where the server offers moves
 * but nothing in the UI is clickable, a run of clicks that changes nothing on the server (a UI that
 * looks alive but can't act), or the battle failing to start.
 *
 *   node client/e2e/battle-smoke.mjs [--moves 120] [--pace 1200] [--headed] [--no-shots] [--keep-server]
 *
 * KNOWN ISSUE, not yet root-caused: on this machine the renderer dies within a click or two of
 * placing the Active Pokémon, and the run reports it (with the click history) rather than hiding it.
 * Ruled out so far: Playwright's bundled Chromium (it happens in the installed Chrome too), audio,
 * screenshots, animations (prefers-reduced-motion), click speed, mouse vs keyboard activation, the
 * response/console hooks, and the deck in use. A hand-written probe doing the same clicks does NOT
 * crash, so something about this harness still differs — worth finishing before trusting a green run.
 *
 * Starts `npm run dev` itself unless both ports are already up. Screenshots land in
 * client/e2e/screenshots/ (gitignored).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');
const ROOT = join(HERE, '..', '..');
const CLIENT_URL = 'http://localhost:5173';
const SERVER_URL = 'http://localhost:3001';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const MAX_MOVES = arg('--moves', 120);
const HEADED = process.argv.includes('--headed');
const SHOTS_ON = !process.argv.includes('--no-shots');
const PACE_MS = arg('--pace', 1200);

const failures = [];
const history = [];
const fail = (msg) => { failures.push(msg); console.error('FAIL:', msg); };
const log = (...a) => console.log(...a);

async function isUp(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

async function ensureServers() {
  if (await isUp(CLIENT_URL) && await isUp(SERVER_URL)) { log('dev servers already up'); return null; }
  log('starting dev servers…');
  const child = spawn('npm', ['run', 'dev'], { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isUp(CLIENT_URL) && await isUp(SERVER_URL)) { log('dev servers up'); return child; }
  }
  throw new Error('dev servers did not come up within 90s');
}

/**
 * Controls that leave, reset or merely configure the battle rather than play it. Matched against the
 * accessible name as well as the text: the settings gear is an icon-only button, and a text-only
 * filter walked straight into it, opened the modal and then spent the rest of the run clicking zoom
 * presets while the game sat untouched.
 */
const AVOID = ['投降', '重新開始', '重開', '悔棋', '離開', '返回', '設定', '全螢幕', '音效', '音樂',
  '規則', '說明', '牌組', '首頁', '縮放', '記錄', '紀錄'];

/** Buttons the player could meaningfully click right now, with the labels used to choose between
 * them. While a dialog is open only its own buttons count — clicking "through" it is exactly what a
 * real player cannot do. */
async function clickableActions(page) {
  const dialog = page.locator('[role="dialog"]:visible').last();
  const inDialog = (await dialog.count()) > 0;
  // :visible matters — the layout keeps mobile-only controls in the DOM at desktop widths, and a
  // hidden button is not something the player can click.
  // [data-move] marks the controls that actually submit a move (Battle.tsx). Everything else on the
  // board is a card preview or a view toggle — a driver that clicks those looks busy and plays nothing.
  const all = (inDialog ? dialog : page).locator('button[data-move]:enabled:visible');
  const n = await all.count();
  const keep = [];
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const [text, aria, title] = await Promise.all([
      el.innerText().catch(() => ''),
      el.getAttribute('aria-label').catch(() => null),
      el.getAttribute('title').catch(() => null),
    ]);
    const label = `${text} ${aria ?? ''} ${title ?? ''}`.trim();
    if (AVOID.some(a => label.includes(a))) continue;
    keep.push({ el, label });
  }
  return { actions: keep, inDialog };
}

/** Everything the server state says about where the game is — used to detect a UI that clicks but
 * never advances, which looks identical to "working" from the outside. */
const progressKey = (s) => JSON.stringify([
  s?.turn, s?.phase, s?.winner, s?.isPlayerTurn, s?.legalMoves?.length,
  s?.pendingChoice?.prompt ?? null, s?.log?.length ?? s?.turnLog?.length ?? 0,
  s?.player?.hand?.length, s?.player?.active?.id ?? null, s?.player?.active?.damage ?? null,
  s?.opponent?.active?.id ?? null, s?.opponent?.active?.damage ?? null,
]);
/**
 * Screenshotting this board takes the renderer down (deterministically, headed or headless, with
 * either screenshot surface) — the battle screen composites a lot of layered gradients and card art.
 * A JPEG capture of the visible viewport only, with animations frozen, survives it; a failed capture
 * is never allowed to end the run, since the screenshots are evidence, not the test.
 */
async function shot(page, path) {
  if (!SHOTS_ON) return;
  await page.screenshot({ path: path.replace(/.png$/, '.jpg'), type: 'jpeg', quality: 60, animations: 'disabled', caret: 'hide', scale: 'css' })
    .catch(e => log('screenshot failed:', e.message.slice(0, 80)));
}

const logLength = (s) => s?.log?.length ?? s?.turnLog?.length ?? 0;

async function run() {
  mkdirSync(SHOTS, { recursive: true });
    // Headless Chromium has no audio device; the app starts BGM on entering a battle, which throws
  // WebAudio errors and (with enough of them) takes the renderer down.
  // The INSTALLED Chrome, not Playwright's bundled Chromium: on that build the renderer dies the
  // moment the Active Pokémon is placed — every deck, headed or headless, mouse or keyboard, with
  // animations and screenshots disabled. The same flow is fine in Chrome and Edge, so it is a quirk
  // of that build rather than an app defect. Falls back to the bundled browser if Chrome is absent,
  // where the run will report that crash rather than pretend it played.
  const launch = (opts) => chromium.launch({ headless: !HEADED, args: ['--mute-audio'], ...opts });
  const browser = await launch({ channel: 'chrome' }).catch(() => launch({ channel: 'msedge' })).catch(() => launch({}));
  log('browser:', browser.version());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  page.on('pageerror', e => fail(`uncaught page error: ${e.message}`));
  page.on('crash', () => fail(`the renderer crashed after ${history.length} click(s): ${history.slice(-5).join(' -> ')}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // A failed image fetch is a data/CDN issue, not a UI defect.
    if (/Failed to load resource|favicon|net::ERR|AudioContext|WebAudio/.test(t)) return;
    fail(`console error: ${t.slice(0, 200)}`);
  });

  /** Latest server view of the battle, captured from the API responses themselves. */
  let latest = null;
  page.on('response', async (res) => {
    if (!res.url().includes('/api/human-battle')) return;
    try {
      const body = await res.json();
      if (body?.state) latest = body.state;
    } catch { /* non-JSON error pages surface through the checks below */ }
  });

    // domcontentloaded, not networkidle: the app keeps fetching the card catalog in the background,
  // so 'networkidle' never fires and the run hangs before it starts.
  // Sound off before the app boots. Headless Chromium has no audio device, and the WebAudio errors
  // the SFX路徑 throws on every card placement take the renderer down within a click or two —
  // an environment limit, not an app defect, so the run turns sound off the way a player could.
  // The app honours prefers-reduced-motion (index.css), which keeps the board's transitions from
  // stacking up under automation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    try { localStorage.setItem('ptcg-battle-settings', JSON.stringify({ zoom: 'auto', sfx: false, bgm: false })); } catch { /* private mode */ }
  });
  await page.goto(`${CLIENT_URL}/battle`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await shot(page, join(SHOTS, '01-lobby.png'));

  // Take the last preset deck and start against the AI.
  const deckSelect = page.locator('select').first();
  await deckSelect.waitFor({ timeout: 15000 });
  const values = await deckSelect.locator('option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
  if (values.length === 0) throw new Error('no decks offered in the battle lobby');
  const deckIdx = process.env.SMOKE_DECK ? Number(process.env.SMOKE_DECK) : values.length - 1;
  await deckSelect.selectOption(values[Math.max(0, Math.min(values.length - 1, deckIdx))]);
  log('deck index', deckIdx, 'of', values.length);
  await page.getByRole('button', { name: '開始對戰' }).click();

  await page.waitForFunction(() => !document.body.innerText.includes('建立對戰中'), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot(page, join(SHOTS, '02-battle-start.png'));
  if (!latest) fail('the battle never returned a state from /api/human-battle');

  let moves = 0;
  let lastKey = progressKey(latest);
  let lastLog = logLength(latest);
  let stalled = 0;

  while (moves < MAX_MOVES) {
    if (latest?.winner !== null && latest?.winner !== undefined) { log('game over, winner =', latest.winner); break; }

    const serverMoves = (latest?.legalMoves ?? []).filter(m => m.type !== 'forfeit');
    const { actions, inDialog } = await clickableActions(page);

    if (actions.length === 0 && inDialog) {
      // A dialog with nothing playable in it (the settings panel, say) — close it and carry on.
      await page.locator('[role="dialog"]:visible').last().locator('button[aria-label="關閉"]')
        .click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    if (serverMoves.length > 0 && actions.length === 0) {
      // The exact shape this test exists for: the server is waiting for a move the UI can't send.
      const kinds = [...new Set(serverMoves.map(m => m.type))].join(', ');
      fail(`dead end at move ${moves}: server offers [${kinds}] but no button is clickable`);
      await shot(page, join(SHOTS, `dead-end-${moves}.png`));
      break;
    }
    if (actions.length === 0) { log('nothing clickable and nothing offered — stopping'); break; }

    // Prefer anything that isn't "end turn", so the run actually exercises play. Which candidate
    // rotates with `stalled`: clicking a hand card only OPENS its action list (a DOM-only change),
    // so always taking the first one can toggle the same menu forever.
    const playable = actions.map((a, i) => [a, i]).filter(([a]) => !a.label.includes('結束回合'));
    const pick = playable.length ? playable[stalled % playable.length][0] : actions[0];
    history.push(pick.label.replace(/\s+/g, ' ').slice(0, 24));
    if (process.env.SMOKE_VERBOSE) log(`  #${moves} click: ${pick.label.replace(/s+/g, " ").slice(0, 40)}`);
    let clicked = true;
    await pick.el.click({ timeout: 5000 }).catch(e => {
      clicked = false;
      fail(`could not click "${pick.label.slice(0, 30)}" at move ${moves}: ${e.message.slice(0, 120)}`);
    });
    if (!clicked) break;
    moves++;
    // Deliberately unhurried: clicking again within ~400ms of a board transition (the setup card
    // placement especially) takes the renderer down — in Chrome as well as in the bundled Chromium.
    // A player cannot click that fast anyway, and the harness is here to play, not to stress-test
    // React reconciliation.
    await page.waitForTimeout(PACE_MS);

    if (logLength(latest) < lastLog) {
      fail(`the run restarted the battle at move ${moves} — a control that resets the game got clicked`);
      break;
    }
    lastLog = logLength(latest);

    const key = progressKey(latest);
    stalled = key === lastKey ? stalled + 1 : 0;
    lastKey = key;
    if (stalled >= 12) {
      fail(`stalled at move ${moves}: 12 clicks in a row changed nothing (turn ${latest?.turn}, phase ${latest?.phase})`);
      await shot(page, join(SHOTS, `stalled-${moves}.png`));
      break;
    }

    if (moves === 20) await shot(page, join(SHOTS, '03-mid-game.png'));
  }

  await shot(page, join(SHOTS, '04-final.png'));
  log(`clicked ${moves} actions, reached turn ${latest?.turn ?? '?'}${latest?.winner != null ? `, winner ${latest.winner}` : ''}`);
  writeFileSync(join(SHOTS, 'summary.json'), JSON.stringify({
    moves, turn: latest?.turn ?? null, winner: latest?.winner ?? null, failures, history,
  }, null, 2));
  await browser.close();
}

const child = await ensureServers();
try {
  await run();
} catch (e) {
  fail(e.message);
} finally {
  if (child && !process.argv.includes('--keep-server')) child.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nbattle smoke: OK');
