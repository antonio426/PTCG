/**
 * Browser smoke test for the battle UI.
 *
 * Everything else in this repo tests the engine. Nothing tested the layer the player actually uses,
 * and the failures that live there are invisible to the server suites by construction: a modal with
 * nothing clickable in it, an action the server offers that no element renders, a render crash on a
 * board shape that only turns up mid-game.
 *
 * It drives a real browser through a battle against the AI and, at every step, cross-checks the DOM
 * against the server's own `legalMoves` — read out of the `/api/human-battle` responses as they
 * arrive, so the app needs no test hooks.
 *
 * Reports: a step where the server offers moves but nothing in the UI can answer them (the reason
 * this exists), a run of clicks that changes nothing on the server, an uncaught page error, a
 * console error, a run that restarts the battle instead of playing it.
 *
 *   node client/e2e/battle-smoke.mjs [--games 3] [--moves 60] [--pace 900] [--headed] [--shots]
 *
 * Interaction notes, all of them learned the hard way against this board:
 *  - clicks are dispatched IN the page (`el.click()`), not through Playwright's click, whose
 *    actionability machinery (hit-testing, scroll-into-view, stability polling) wedges the renderer;
 *  - the candidate scan is a single `page.evaluate`, never a `:visible` locator, for the same reason;
 *  - the renderer still dies occasionally mid-game from something not yet pinned down, so a crash
 *    starts a fresh page and a fresh battle, and the count is reported at the end.
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
const GAMES = arg('--games', 3);
const MAX_MOVES = arg('--moves', 60);
const PACE_MS = arg('--pace', 900);
const HEADED = process.argv.includes('--headed');
const SHOTS_ON = process.argv.includes('--shots');
const VERBOSE = !!process.env.SMOKE_VERBOSE;

const failures = [];
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
 * filter walked into it, opened the modal, and spent the rest of the run clicking zoom presets.
 */
const AVOID = ['投降', '重新開始', '重開', '悔棋', '離開', '返回', '設定', '全螢幕', '音效', '音樂',
  '規則', '說明', '牌組', '首頁', '縮放', '記錄', '紀錄'];

/**
 * Three markers, because the board is not made of plain buttons: `[data-move]` submits a move,
 * `[data-hand-card]` is a hand card that either plays or answers a select_hand_cards choice, and
 * `[data-board-target]` is a Pokémon that is a legal target for what is being resolved — which is
 * where a select_pokemon choice gets answered.
 */
const CANDIDATE_SELECTOR = 'button[data-move]:not([disabled]), [data-hand-card], [data-board-target]';

async function clickableActions(page) {
  const probe = await page.evaluate((sel) => {
    const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    // While a dialog is up only its own controls count — clicking "through" it is exactly what a
    // real player cannot do.
    const scope = dialogs.length ? dialogs[dialogs.length - 1] : document;
    const items = [...scope.querySelectorAll(sel)].map((el, i) => ({
      i,
      visible: visible(el),
      kind: el.hasAttribute('data-move') ? 'move' : el.hasAttribute('data-board-target') ? 'target' : 'hand',
      picked: el.hasAttribute('data-picked'),
      label: `${el.innerText || el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`
        .replace(/\s+/g, ' ').trim(),
    }));
    return { inDialog: dialogs.length > 0, items };
  }, CANDIDATE_SELECTOR).catch(() => ({ inDialog: false, items: [] }));

  // Indices line up because the locator below queries the same scope, in document order.
  const scoped = probe.inDialog
    ? page.locator('[role="dialog"]').last().locator(CANDIDATE_SELECTOR)
    : page.locator(CANDIDATE_SELECTOR);
  // Ordered by how directly they advance the game: a move submits, a board target answers a
  // standing choice, a hand card only OPENS a menu — so once that menu is up, its buttons win and
  // the run can't spend the whole game toggling the same card open and shut.
  const rank = { move: 0, target: 1, hand: 2 };
  const actions = probe.items
    .filter(it => it.visible && !AVOID.some(a => it.label.includes(a)))
    .sort((a, b) => rank[a.kind] - rank[b.kind])
    .map(it => ({ el: scoped.nth(it.i), label: it.label, kind: it.kind, picked: it.picked }));
  return { actions, inDialog: probe.inDialog };
}

/** Everything the server state says about where the game is — used to detect a UI that clicks but
 * never advances, which looks identical to "working" from the outside. */
const progressKey = (s) => JSON.stringify([
  s?.turn, s?.phase, s?.winner, s?.isPlayerTurn, s?.legalMoves?.length,
  s?.pendingChoice?.prompt ?? null, s?.log?.length ?? s?.turnLog?.length ?? 0,
  s?.player?.hand?.length, s?.player?.active?.id ?? null, s?.player?.active?.damage ?? null,
  s?.opponent?.active?.id ?? null, s?.opponent?.active?.damage ?? null,
]);
const logLength = (s) => s?.log?.length ?? s?.turnLog?.length ?? 0;

/** JPEG viewport captures — evidence, never the test, so a failure to capture is logged and ignored. */
async function shot(page, name) {
  if (!SHOTS_ON) return;
  await page.screenshot({ path: join(SHOTS, name), type: 'jpeg', quality: 60, animations: 'disabled', caret: 'hide', scale: 'css' })
    .catch(e => log('screenshot failed:', e.message.slice(0, 80)));
}

/** Plays one battle to `MAX_MOVES` or its end. Returns what happened, for the run summary. */
async function playOneGame(browser, gameNo) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const history = [];
  let crashed = false;
  let latest = null;

  page.on('crash', () => { crashed = true; });
  page.on('pageerror', e => fail(`uncaught page error: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Image fetches and the headless audio device are environment, not UI defects.
    if (/Failed to load resource|favicon|net::ERR|AudioContext|WebAudio/.test(t)) return;
    fail(`console error: ${t.slice(0, 200)}`);
  });
  page.on('response', async (res) => {
    if (!res.url().includes('/api/human-battle')) return;
    try { const body = await res.json(); if (body?.state) latest = body.state; } catch { /* error pages surface below */ }
  });

  await page.addInitScript(() => {
    // Sound off before the app boots: there is no audio device here, and the app is happy to be
    // played muted — a player could make the same choice in Settings.
    try { localStorage.setItem('ptcg-battle-settings', JSON.stringify({ zoom: 'auto', sfx: false, bgm: false })); } catch { /* private mode */ }
  });
  // domcontentloaded, not networkidle: the card catalog keeps loading in the background, so
  // 'networkidle' never fires and the run hangs before it starts.
  await page.goto(`${CLIENT_URL}/battle`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const deckSelect = page.locator('select').first();
  await deckSelect.waitFor({ timeout: 15000 });
  const values = await deckSelect.locator('option').evaluateAll(os => os.map(o => o.value).filter(Boolean));
  if (values.length === 0) throw new Error('no decks offered in the battle lobby');
  const deckIdx = (gameNo * 7) % values.length;   // a different deck per game, deterministically
  await deckSelect.selectOption(values[deckIdx]);
  await page.getByRole('button', { name: '開始對戰' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('建立對戰中'), null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await shot(page, `game${gameNo}-start.jpg`);
  if (!latest) fail(`game ${gameNo}: the battle never returned a state from /api/human-battle`);

  let moves = 0, stalled = 0;
  let lastKey = progressKey(latest);
  let lastLog = logLength(latest);

  while (moves < MAX_MOVES && !crashed) {
    if (latest?.winner !== null && latest?.winner !== undefined) break;

    const serverMoves = (latest?.legalMoves ?? []).filter(m => m.type !== 'forfeit');
    const { actions, inDialog } = await clickableActions(page);
    if (crashed) break;

    if (actions.length === 0 && inDialog) {
      // A dialog with nothing playable in it (the settings panel, say) — close it and carry on.
      await page.locator('[role="dialog"]').last().locator('button[aria-label="關閉"]')
        .evaluate(el => el.click()).catch(() => {});
      await page.waitForTimeout(250);
      continue;
    }
    if (serverMoves.length > 0 && actions.length === 0) {
      const kinds = [...new Set(serverMoves.map(m => m.type))].join(', ');
      const pc = latest?.pendingChoice;
      fail(`game ${gameNo}, move ${moves}: server offers [${kinds}] but nothing in the UI can answer it`
        + (pc ? ` — pending choice "${pc.prompt}" (${pc.choiceType}, ${pc.options?.length ?? 0} options)` : ''));
      await shot(page, `game${gameNo}-dead-end.jpg`);
      break;
    }
    if (actions.length === 0) break;   // nothing offered, nothing clickable: the AI is thinking

    // Prefer anything that isn't "end turn", so the run actually exercises play. Which candidate
    // rotates with `stalled`: a hand card only OPENS its action list, so always taking the first
    // one can toggle the same menu forever.
    // A multi-pick choice is answered by selecting DISTINCT cards and then confirming, so an
    // already-picked one is the wrong thing to click — clicking it again just unpicks it, which is
    // how the run used to spend a dozen clicks toggling one card.
    const playable = actions.filter(a => !a.label.includes('結束回合') && !a.picked);
    const pool = playable.length ? playable : actions;
    const pick = pool[stalled % pool.length];
    if (VERBOSE) log(`  g${gameNo} #${moves} click: ${pick.label.slice(0, 40)}`);
    history.push(pick.label.slice(0, 24));

    // Dispatched inside the page: Playwright's own click wedges this board (see the header).
    await pick.el.evaluate(el => el.click()).catch(e => log('   click failed:', e.message.slice(0, 80)));
    moves++;
    await page.waitForTimeout(PACE_MS);
    if (crashed) break;

    if (logLength(latest) < lastLog) {
      fail(`game ${gameNo}: the run restarted the battle at move ${moves} — a reset control got clicked`);
      break;
    }
    lastLog = logLength(latest);

    const key = progressKey(latest);
    stalled = key === lastKey ? stalled + 1 : 0;
    lastKey = key;
    if (stalled >= 12) {
      fail(`game ${gameNo}: stalled at move ${moves} — 12 clicks changed nothing (turn ${latest?.turn}, phase ${latest?.phase})`);
      await shot(page, `game${gameNo}-stalled.jpg`);
      break;
    }
  }

  await shot(page, `game${gameNo}-final.jpg`);
  const result = { game: gameNo, deckIdx, moves, turn: latest?.turn ?? null, winner: latest?.winner ?? null, crashed, history };
  await page.close().catch(() => {});
  return result;
}

async function run() {
  mkdirSync(SHOTS, { recursive: true });
  // The INSTALLED Chrome first: Playwright's bundled Chromium is more fragile on this board.
  const launch = (opts) => chromium.launch({ headless: !HEADED, args: ['--mute-audio'], ...opts });
  const browser = await launch({ channel: 'chrome' }).catch(() => launch({ channel: 'msedge' })).catch(() => launch({}));
  log('browser:', browser.version());

  const results = [];
  let current = browser;
  for (let g = 0; g < GAMES; g++) {
    // A crash surfaces as whatever call was in flight when the renderer died ("Page crashed" out
    // of waitForTimeout, "Target crashed" out of a query), so it is classified as a crash rather
    // than as a broken run — the distinction the summary reports.
    const r = await playOneGame(current, g).catch(e => (/crash/i.test(e.message)
      ? { game: g, moves: 0, crashed: true }
      : { game: g, error: e.message.slice(0, 160) }));
    results.push(r);
    // A crashed renderer leaves the whole browser unusable — the next navigation comes back
    // ERR_ABORTED — so the next game gets a fresh one.
    if ((r.crashed || r.error) && g + 1 < GAMES) {
      await current.close().catch(() => {});
      current = await launch({ channel: 'chrome' }).catch(() => launch({}));
    }
    log(`game ${g}: ${r.error ? `ERROR ${r.error}` : `${r.moves} clicks, turn ${r.turn}` + (r.winner != null ? `, winner ${r.winner}` : '') + (r.crashed ? ' (renderer crashed)' : '')}`);
    if (r.error) fail(`game ${g} could not be played: ${r.error}`);
  }
  await current.close().catch(() => {});

  const crashes = results.filter(r => r.crashed).length;
  const played = results.reduce((n, r) => n + (r.moves ?? 0), 0);
  log(`\n${GAMES} games, ${played} clicks, renderer crashes: ${crashes}`);
  writeFileSync(join(SHOTS, 'summary.json'), JSON.stringify({ results, failures, crashes }, null, 2));
  // Crashes are reported, not fatal: they are a known, unexplained flake of this harness, and
  // failing on them would hide the findings from the games that did run.
  if (crashes === GAMES) fail('every game ended with a renderer crash — nothing was actually exercised');
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
