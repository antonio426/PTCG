# CLAUDE.md

本檔案為 Claude Code（claude.ai/code）在此專案中工作時的操作指南。

## 語言

以後都用繁體中文回答。

## 專案概述

PTCG Game 是一個 Pokémon TCG 風格的卡牌對戰專案：React 前端、Koa/boardgame.io 遊戲伺服器，以及共用的 TypeScript 套件。卡片資料即時來自 TCGdex v2 API（`https://api.tcgdex.net/v2/`），並會快取到硬碟。專案採用 npm workspaces monorepo 架構（`shared`、`server`、`client`）。

## 常用指令

以下指令請在 `ptcg-game/`（workspace 根目錄，而非上一層的 repo 根目錄）執行。

```bash
npm install                # 安裝所有 workspace 的依賴
npm run dev                # 同時啟動 server + client（concurrently）
npm run dev:server         # 僅啟動 server — tsx watch src/index.ts（port 3001）
npm run dev:client         # 僅啟動 client — vite（port 5173）
npm run build               # 依序 build shared -> server -> client
```

Windows 替代方案：在 `ptcg-game/` 執行 `./start-dev.ps1`（會以 PowerShell background job 啟動前後端；可帶 `-ServerPort` / `-ClientPort` 參數）。

各 workspace 內部指令（在 `server/` 或 `client/` 目錄下執行）：
```bash
npm run dev                # server：tsx watch；client：vite
npm run build               # server：tsc；client：tsc -b && vite build
npm run start                # 僅 server — 執行 dist/index.js（build 之後）
npm run preview              # 僅 client — 預覽 production build
```

目前任何 workspace 都沒有設定測試套件或 lint 指令 — 不要自行捏造 `npm test` 或 `npm run lint`。

型別檢查：server 使用 `tsc`（輸出到 `dist/`），client 使用 `tsc -b`（project references，透過 build mode 達到類似 `noEmit` 的效果）。`shared` 沒有 build 步驟 — 它是以 TypeScript 原始碼直接被引用的（`"main": "index.ts"`），透過 workspace symlink 提供給 client/server，因此修改後 client 與 server 會立即讀到最新內容，不需要重新 build。

## 架構

### Workspace 結構
- `shared/` — 前後端共用的 TypeScript 型別/常數，以 `@ptcg/shared` 匯入（`shared/types/{card,game,action}.ts`）。純原始碼套件，無 build 步驟。
- `server/` — 包裹 `boardgame.io` `Server` 的 Koa 應用程式，另外還有一套獨立於 boardgame.io 的純 REST 對戰實作（見下方說明）。
- `client/` — React 19 + Vite + Tailwind + Zustand + React Router。Vite dev server 會將 `/api` 與 `/ws` 代理到 `http://localhost:3001`（`client/vite.config.ts`）。

### 兩套並行的對戰引擎
遊戲邏輯（`server/src/game/{moves,validation,damage,setup}.ts`，狀態結構定義於 `GameState.ts`）是共用的，但實際上有兩種不同的驅動方式：
1. **`boardgame.io` 遊戲**（`server/src/game/PtcgGame.ts`）— 在 `index.ts` 中註冊到 `boardgame.io/server`，透過 boardgame.io 的 lobby/match API 對外提供服務。將 `moves` 接到 boardgame.io 的 `Game` 定義中（`turn.onBegin`、`endIf`）。
2. **自訂的人類對 AI REST 迴圈**（`server/src/routes/humanBattle.ts`）— 重新實作了一個簡化版、模仿 boardgame.io 的 `ctx`（`{ currentPlayer, events.endTurn }`），手動推進回合、檢查勝利條件，並以記憶體中的 `Map` 儲存對戰 session。`client/src/pages/Battle.tsx` 實際溝通的就是這一套（`POST /api/human-battle`、`POST /api/human-battle/:id/move`）。
3. 第三種變體 `server/src/ai/battleRunner.ts`，以無介面（headless）迴圈驅動同一套 `moves`/`validation` 邏輯來做 AI 對 AI 的模擬（`runBattles`），供 `BattleLab.tsx` 透過 `server/src/routes/battles.ts` 用來測試不同 AI 策略之間的勝率。

修改回合/出牌相關邏輯時，務必確認是否也要同步修改 `humanBattle.ts` 的 `executeGameAction`/`applyTurnBegin`，以及 `battleRunner.ts` 的 `executeMove`/`applyTurnBegin` — 因為它們是各自複製（而非共用）boardgame.io 的回合生命週期邏輯。

### AI 玩家（`server/src/ai/aiPlayer.ts`）
共同介面為 `IAIPlayer.decide(gameState, playerIndex, legalMoves)`。目前實作：
- `RandomAI` — 從合法行動中隨機選一個。
- `MockAI` — 依優先順序的啟發式策略（攻擊 > 進化 > 附能量 > 出寶可夢 > ...）。目前是人類對戰的預設對手（`humanBattle.ts`）。
- `ClaudeAI` — 直接呼叫 Anthropic Messages API（`fetch` 到 `api.anthropic.com`，使用 `select_action` 這個 tool），傳入完整渲染成繁體中文的遊戲狀態 prompt，再把 tool call 結果解析回 `LegalAction`。需要 `config.apiKey`；目前尚未被任何路由設為預設值。

合法行動的產生邏輯集中在 `server/src/game/validation.ts`（`getLegalMoves`）— 這是「玩家 X 現在能做什麼」的唯一真實來源，上述三套對戰路徑都會用到它。

### 卡片資料流程（`server/src/card-api/tcgdex.ts`）
- 從 TCGdex v2 抓取資料（預設語系 `zh-tw`），轉換成專案共用的 `Card`/`MapCard` 格式（參見 `CATEGORY_MAP`、`ENERGY_MAP`、`TRAINER_TYPE_MAP`、`STAGE_MAP` 等對照表 — TCGdex 的用詞與本專案的 `Subtype`/`EnergyType` 型別並不完全一致）。
- 兩階段載入：`fetchAllCards()` 先載入成本較低的分類摘要資料（僅 id/name/image，沒有招式/HP 等），接著 `enrichAllCardsInBackground()` 以每批 5 張的方式抓取每張卡的完整詳細資料，並就地更新記憶體中的陣列。一張卡只要有 `artist` 欄位或 `_enriched: true` 就視為「已補完（enriched）」；需要招式/HP/弱點等資料的 UI 程式碼，應該能容忍卡片仍是摘要版本、尚未補完的狀態（完整補完約 6000 張卡需要 10–15 秒）。
- 硬碟快取：`server/src/card-api/cache.ts` 會把資料存到 `server/data/cards.json` / `server/data/sets.json`，並包一層 24 小時 TTL（`{ timestamp, data }`）。`server/data/cards-final.json` 是另一份由 `server/src/scripts/` 內的一次性腳本合併/修補產生的、規模更大的資料集 — 使用前務必確認某個 script 或 route 實際讀的是哪一份檔案，不要假設它們可以互換。
- 圖片絕不會直接把 TCGdex CDN 網址回傳給前端；`buildImageUrl` 一律指向 `/api/images/{serie}/{setId}/{localId}/{high|low}`（`server/src/routes/images.ts`），由該路由代理到本地快取，找不到才 fallback 到 CDN。
- 卡片 ID 格式為 `{SetCode}-{Number}`（例如 `SV1V-001`）。**已知未解決問題**：`server/data/preset-decks*.json` 以及部分較舊、存在 `localStorage` 的使用者牌組，使用的是舊版爬蟲 ID 格式（例如 `scr-14129`），與目前 TCGdex 的 ID 對不上，導致這些牌組在 `fetchCardsByIds` 查詢時失敗（完整說明與候選解法見 `ptcg-game/AGENTS.md`）。

### 前端結構
- `client/src/stores/` — Zustand stores：`cardStore`（卡片目錄/搜尋狀態）、`deckStore`（牌組編輯器：`addCard`、`validateDeck` — 60 張牌 / 同名卡最多 4 張規則，一般能量除外、`saveDeck`/`loadDeck` 存取 `localStorage`）、`gameStore`（對戰 session 狀態）。
- `client/src/pages/` — `Home`、`CardBrowser`、`DeckBuilder`、`Battle`（人類對 AI，溝通對象為 `humanBattle.ts`）、`BattleLab`（AI 對 AI 模擬測試介面，溝通對象為 `battles.ts`）。
- `deckStore.validateDeck` 遇到目前卡片目錄中找不到的 ID 會直接跳過該卡，而不是報錯失敗 — 這是刻意設計，用來容忍上述的舊版 ID 牌組，不要把它「修正」成會 throw 的版本。

### 一次性資料腳本
`server/src/scripts/` 存放匯入/爬取/合併/修補用的腳本（例如 `scrape-official-standard.ts`、`merge-all-official.ts`、`patch-ace-spec.ts`），用來建立/修復 `server/data/*.json` 的資料快照。這些腳本是用 `tsx` 手動執行的，不屬於日常開發流程的一部分 — 執行前請先讀過該腳本的內容，因為有些會直接就地修改 `server/data/*.json`。
