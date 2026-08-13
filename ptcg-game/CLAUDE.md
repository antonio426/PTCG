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

### AI 玩家
共同介面為 `IAIPlayer.decide(gameState, playerIndex, legalMoves)`。目前實作：
- `RandomAI`（`server/src/ai/aiPlayer.ts`）— 從合法行動中隨機選一個。對應難度 `easy`。
- `MockAI`（`server/src/ai/aiPlayer.ts`）— 依優先順序的簡單啟發式策略（攻擊 > 進化 > 附能量 > 出寶可夢 > ...）。已不是預設對手，僅供比較用。
- `HeuristicAI`（`server/src/ai/heuristicAI.ts`）— 對每個合法行動評分後選最高分，會讀卡片實際內容（訓練家/特性效果文字關鍵字、可付的攻擊傷害等）計分，也有主動撤退換更強攻擊手等戰術判斷。**目前是人類對戰的預設對手**（`humanBattle.ts` 的 `resolveAiPlayer`，難度 `normal` 或未指定時使用）。
- `ClaudeAI`（`server/src/ai/aiPlayer.ts`）— 直接呼叫 Anthropic Messages API（`fetch` 到 `api.anthropic.com`，使用 `select_action` 這個 tool），傳入完整渲染成繁體中文的遊戲狀態 prompt，再把 tool call 結果解析回 `LegalAction`。對應難度 `hard`；需要環境變數 `ANTHROPIC_API_KEY`（`ANTHROPIC_MODEL` 可選），沒設定時 `resolveAiPlayer` 會回傳錯誤而不是靜默降級成別的 AI。

`humanBattle.ts` 的 `resolveAiPlayer(difficulty?)` 是難度 → AI 類型的唯一對照表。`BattleLab`／`battles.ts` 的 `/api/battles/ai-vs-ai` 則是另一套獨立的對照（`aiTypeA`/`aiTypeB` 參數，接受 `random`/`mock`/`heuristic`/`claude`），用來讓兩種 AI 策略互相比賽測勝率——修改難度或 AI 選型邏輯時，這兩處要分別確認是否要同步調整。

合法行動的產生邏輯集中在 `server/src/game/validation.ts`（`getLegalMoves`）— 這是「玩家 X 現在能做什麼」的唯一真實來源，前面三套對戰路徑都會用到它。

### 進化史堆疊（`GameCard.preEvolutions`）
真實規則：進化不會立刻把進化前的卡丟進棄牌堆——它會疊在新卡底下，直到這隻寶可夢整疊被擊倒（或以其他方式永久離場）時才一起進棄牌堆。`shared/types/game.ts` 的 `GameCard.preEvolutions?: GameCard[]`（舊到新排序）就是這疊歷史。`server/src/game/damage.ts` 匯出兩個共用 helper：`stackAsPreEvolution(newTop, oldCard)`（進化時呼叫，取代直接 push 進棄牌堆）與 `flushPreEvolutionsToDiscard(card, discardPile)`（KO、彈回手牌、洗回牌庫等任何「這張卡永久離開目前這疊」的時機都要呼叫，避免整疊歷史卡憑空消失）。新增任何會讓寶可夢進化/降階/離場的效果時，記得檢查是否也要處理這疊歷史。

### 卡片資料流程（`server/src/card-api/tcgdex.ts`）
- 從 TCGdex v2 抓取資料（預設語系 `zh-tw`），轉換成專案共用的 `Card`/`MapCard` 格式（參見 `CATEGORY_MAP`、`ENERGY_MAP`、`TRAINER_TYPE_MAP`、`STAGE_MAP` 等對照表 — TCGdex 的用詞與本專案的 `Subtype`/`EnergyType` 型別並不完全一致）。
- 兩階段載入：`fetchAllCards()` 先載入成本較低的分類摘要資料（僅 id/name/image，沒有招式/HP 等），接著 `enrichAllCardsInBackground()` 以每批 5 張的方式抓取每張卡的完整詳細資料，並就地更新記憶體中的陣列。一張卡只要有 `artist` 欄位或 `_enriched: true` 就視為「已補完（enriched）」；需要招式/HP/弱點等資料的 UI 程式碼，應該能容忍卡片仍是摘要版本、尚未補完的狀態（完整補完約 6000 張卡需要 10–15 秒）。
- 硬碟快取：`server/src/card-api/cache.ts` 會把資料存到 `server/data/cards.json` / `server/data/sets.json`，並包一層 24 小時 TTL（`{ timestamp, data }`）。`server/data/cards-final.json` 是另一份由 `server/src/scripts/` 內的一次性腳本合併/修補產生的、規模更大的資料集 — 使用前務必確認某個 script 或 route 實際讀的是哪一份檔案，不要假設它們可以互換。
- 圖片絕不會直接把 TCGdex CDN 網址回傳給前端；`buildImageUrl` 一律指向 `/api/images/{serie}/{setId}/{localId}/{high|low}`（`server/src/routes/images.ts`），由該路由代理到本地快取，找不到才 fallback 到 CDN。
- 卡片 ID 格式為 `{SetCode}-{Number}`（例如 `SV1V-001`）。**已知未解決問題**：`server/data/preset-decks*.json` 以及部分較舊、存在 `localStorage` 的使用者牌組，使用的是舊版爬蟲 ID 格式（例如 `scr-14129`），與目前 TCGdex 的 ID 對不上，導致這些牌組在 `fetchCardsByIds` 查詢時失敗（完整說明與候選解法見 `ptcg-game/AGENTS.md`）。
- **已知未解決問題**：`cards.json`/`cards-final.json` 裡個別卡片印刷版本會漏掉 `abilities`/`attacks` 欄位——即使同一張卡的其他印刷版本（同名同副屬性同 HP）有完整資料，UI 仍會照 `cardData.abilities` 顯示效果文字，但遊戲邏輯查不到資料就等於該效果被無聲跳過。不是全部同名卡都能直接互相回填：同名卡在不同印刷版本有時是完全不同的設計（招式/特性都不同），回填前務必用 `find-sibling-data-gaps.ts`（見下方）比對招式簽章，不要只憑同名同 HP 就假設是同一張卡。

### 前端結構
- `client/src/stores/` — Zustand stores：`cardStore`（卡片目錄/搜尋狀態）、`deckStore`（牌組編輯器：`addCard`、`validateDeck` — 60 張牌 / 同名卡最多 4 張規則，一般能量除外、`saveDeck`/`loadDeck` 存取 `localStorage`）、`gameStore`（對戰 session 狀態）。
- `client/src/pages/` — `Home`、`CardBrowser`、`DeckBuilder`、`Battle`（人類對 AI，溝通對象為 `humanBattle.ts`）、`BattleLab`（AI 對 AI 模擬測試介面，溝通對象為 `battles.ts`）。
- `deckStore.validateDeck` 遇到目前卡片目錄中找不到的 ID 會直接跳過該卡，而不是報錯失敗 — 這是刻意設計，用來容忍上述的舊版 ID 牌組，不要把它「修正」成會 throw 的版本。

### 一次性資料腳本
`server/src/scripts/` 存放匯入/爬取/合併/修補用的腳本（例如 `scrape-official-standard.ts`、`merge-all-official.ts`、`patch-ace-spec.ts`），用來建立/修復 `server/data/*.json` 的資料快照。這些腳本是用 `tsx` 手動執行的，不屬於日常開發流程的一部分 — 執行前請先讀過該腳本的內容，因為有些會直接就地修改 `server/data/*.json`。臨時的一次性驗證/稽核腳本用完即刪（慣例用 `_` 前綴命名，例如 `_verify-xxx.ts`），不要留在 repo 裡。

### 卡片邏輯覆蓋率稽核工具
用來找「卡片文字寫了效果、但遊戲裡沒有真的執行」這類不會讓遊戲崩潰、也不會被一般測試發現的隱藏漏洞，分兩支互補的腳本（都用 `npx tsx src/scripts/<name>.ts` 執行，在 `server/` 目錄下）：
- `coverage-report.ts` — 找「資料有寫、程式沒接」：比對 `abilityEffects`/`trainerEffects`/`attackEffects`（`server/src/game/effects/{abilities,trainers,attacks}.ts`）的 key 是否涵蓋 `cards.json` 裡實際出現過的特性/訓練家/攻擊名稱，依重印次數排序輸出，結果存到 `data-scraped/coverage-uncovered-*.json`。
- `find-sibling-data-gaps.ts` — 找「資料本身就漏寫」：把同名卡分組，比對是否有印刷版本缺 `abilities`/`attacks` 而其他印刷版本（招式簽章相符）有，輸出候選清單到 `data-scraped/sibling-data-gaps.json`。**這支工具只能抓到「有姊妹版本可比對」的缺口**，孤例卡片抓不到，且比對出的候選仍需人工核對招式/HP 是否真的是同一張卡才能回填，不要盲目自動套用。

`cards.json` 每次重新抓取/enrich 後這兩份報告就可能過期，改動卡片效果實作或懷疑有資料缺口時應該重跑一次。

## 成本 /情境使用紀律

此專案的使用者對 token 用量敏感，長時間 session 容易不知不覺耗盡額度。請遵守：
- 回覆盡量精簡，不要重複輸出已經在對話中出現過的內容（例如剛編輯過的檔案，Edit 成功後不需要再 Read 一次確認）。
- 避免重新讀取已經在上下文中的檔案；需要引用時直接用 `file:line` 標記即可。
- 對話變長時（尤其是連續多輪工具呼叫之後），主動建議使用者執行 `/compact`，不要等到被 `.claude/hooks/context-guard.js` 這個 PreToolUse hook 擋下來才處理（該 hook 會在 transcript 超過約 10 萬 token 時警告、超過約 18 萬 token 時直接封鎖 Bash/Edit/Write，並要求先 `/compact`）。
- 大型一次性稽核/爬蟲腳本盡量寫在 scratchpad 或 `server/src/scripts/` 裡執行完就刪除（如既有慣例），不要把大量中間產出貼回對話內容。
- AI 對戰壓力測試（`battleRunner.ts`/BattleLab）的場數要跟改動的影響範圍成比例：單純新增、不牽動既有程式路徑的小改動（新特性 handler、資料回填）抽測幾副牌即可，不必每次都跑滿 56 副預組牌組；牽動共用邏輯（進化系統、AI 評分等）的改動才需要全套跑一輪。用 `HeuristicAI`/`RandomAI`/`MockAI` 互打不會呼叫 Anthropic API、不花真正的 token，但終端機輸出仍會佔用對話上下文，保持輸出精簡（進度列 + 摘要）。
