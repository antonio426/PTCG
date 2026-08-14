<!-- 這是 CLAUDE.md 的繁體中文對照版，純粹給你（人類）方便閱讀用。
     Claude Code 實際讀取、當作操作指南的是英文版 CLAUDE.md（英文 token 效率比中文高，
     省成本）。這份檔案不會被自動載入，也不保證跟英文版逐字同步——如果之後改了
     CLAUDE.md，記得回來手動更新這份對照版，或請 Claude 幫你同步翻譯一次。 -->

# CLAUDE.md（中文對照）

本檔案為 Claude Code（claude.ai/code）在此專案中工作時的操作指南。

## 語言

以後都用繁體中文回答。

## 專案概述

PTCG Game 是一個 Pokémon TCG 風格的卡牌對戰專案：React 前端、Koa/boardgame.io 遊戲伺服器，以及共用的 TypeScript 套件。專案採用 npm workspaces monorepo 架構（`shared`、`server`、`client`）。

卡片資料來自三個彼此獨立的來源——不要假設它們互相一致：
- **TCGdex v2 API**（`https://api.tcgdex.net/v2/`）— 主要的結構化資料來源，會快取到硬碟（見下方「卡片資料流程」）。個別印刷版本可能漏欄位（見「反覆踩過的坑」）。
- **官方繁體中文卡查網站**（`https://asia.pokemon-card.com/tw/card-search/list/`）— 以 HTML 爬取 TCGdex 拿不到的文字資料（見下方「官網文字爬蟲」），效果文字通常更完整正確，但需要自己解析。
- **別人做的同款遊戲參考實作**（`https://www.ptcg-tw-sim.com/game`）— 不是資料來源，而是拿來對真實行為做「地面真相（ground truth）」驗證的目標。之前的 session 有好幾次是靠實際在這個網站打一場真的對局、逐回合跟這個 codebase 比對，才抓到光看爬蟲文字看不出來的真 bug（沒接上的死程式碼、UI 流程假設錯誤、以及一條回合生命週期的核心規則，見 commit `128b755`、`bfc6c70`）。當某個效果或規則對不對還沒把握、且 coverage 工具本身無法下定論時，優先去這個網站實際驗證，而不是繼續重讀爬蟲文字。

  這件事可以自動化：`playwright` 已經是 workspace 根目錄的 devDependency，而且 `.playwright-mcp/` 跟 `*.png` 都已被 gitignore，臨時的驅動腳本跟截圖放那裡即可。可行流程：`本機雙人對戰` → 用兩個 `<select>` 選雙方牌組（它的 `<option>` 文字跟本專案的預組牌組名稱完全一致）→ `開始 vs AI`。接著把基礎寶可夢從 `.hand-scroll > *` 拖到 `拖曳基礎寶可夢到這裡` 的放置區再確認。兩個雷點：按鈕要用 DOM 層級的 `.click()`（比對 `innerText`）來點，Playwright 自己的 click 會被該網站的覆蓋層擋到逾時；還有該網站自己的事件記錄（最有價值的產物，因為它會把每條規則觸發時逐條講出來）在 class 符合 `/log/i` 的那個元素裡。

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

動卡片邏輯前要知道的兩個慣例：
- **`EffectHandler.canPlay?`**（`effects/types.ts`）：一張此刻效果完全無法生效的訓練家卡，必須定義 canPlay（鏡射自己 `start()` 的失敗條件）——`getLegalMoves` 就不會提供這張牌，`playTrainer` 對強行打出的也會退回手牌（否則卡片會被白白棄掉）。只適用於需求在**公開區域**（棄牌區/場上）的卡：真實規則允許打出撲空的牌庫搜尋，所以牌庫搜尋類**不能**加 canPlay。刻意不做 refund 型 EffectStep——用 gate 可避免文件已記載的 AI 無限重試迴圈。
- **特性消除**（暗夜羽擊）：實作在 `passiveAbilities.ts` 唯一的持有判定入口 `hasAbility(G, card, name)`（對外名 `hasPassiveAbilityNamed`），加上給 `useAbility`/`getLegalMoves` 查的 `areAbilitiesNegated(G, card)`。作用範圍刻意收窄——只有雙方戰鬥位會互相影響。之後任何「特性被消除」類效果都應該擴充 `areAbilitiesNegated`，不要另起爐灶。

### 進化史堆疊（`GameCard.preEvolutions`）
真實規則：進化不會立刻把進化前的卡丟進棄牌堆——它會疊在新卡底下，直到這隻寶可夢整疊被擊倒（或以其他方式永久離場）時才一起進棄牌堆。`shared/types/game.ts` 的 `GameCard.preEvolutions?: GameCard[]`（舊到新排序）就是這疊歷史。`server/src/game/damage.ts` 匯出兩個共用 helper：`stackAsPreEvolution(newTop, oldCard)`（進化時呼叫，取代直接 push 進棄牌堆）與 `flushPreEvolutionsToDiscard(card, discardPile)`（KO、彈回手牌、洗回牌庫等任何「這張卡永久離開目前這疊」的時機都要呼叫，避免整疊歷史卡憑空消失）。新增任何會讓寶可夢進化/降階/離場的效果時，記得檢查是否也要處理這疊歷史。

### 卡片資料流程（`server/src/card-api/tcgdex.ts`）
- 從 TCGdex v2 抓取資料（預設語系 `zh-tw`），轉換成專案共用的 `Card`/`MapCard` 格式（參見 `CATEGORY_MAP`、`ENERGY_MAP`、`TRAINER_TYPE_MAP`、`STAGE_MAP` 等對照表 — TCGdex 的用詞與本專案的 `Subtype`/`EnergyType` 型別並不完全一致）。
- 兩階段載入：`fetchAllCards()` 先載入成本較低的分類摘要資料（僅 id/name/image，沒有招式/HP 等），接著 `enrichAllCardsInBackground()` 以每批 5 張的方式抓取每張卡的完整詳細資料，並就地更新記憶體中的陣列。一張卡只要有 `artist` 欄位或 `_enriched: true` 就視為「已補完（enriched）」；需要招式/HP/弱點等資料的 UI 程式碼，應該能容忍卡片仍是摘要版本、尚未補完的狀態（完整補完約 6000 張卡需要 10–15 秒）。
- 硬碟快取：`server/src/card-api/cache.ts` 會把資料存到 `server/data/cards.json` / `server/data/sets.json`（`{ timestamp, data }` 包裝）。**這兩個檔案是精修過的資料集，不是可丟棄的快取**——一次性腳本的回填/修補是直接寫進去的。舊的 24 小時 TTL 檢查會讓「距上次存檔超過 24 小時後的任何一次啟動」悄悄用 TCGdex 的裸摘要資料整包取代目錄，反覆把已修好的卡「還原成壞的」；因此現在載入時一律忽略 TTL，只有檔案不存在、或明確設了 `PTCG_REFRESH_CARDS=1` 才會重抓（重抓後要重跑各修補腳本）。`server/data/cards-final.json` 是另一份由 `server/src/scripts/` 內的一次性腳本合併/修補產生的、規模更大的資料集 — 使用前務必確認某個 script 或 route 實際讀的是哪一份檔案，不要假設它們可以互換。註：目前實際跑起來的 server 只會讀寫 `cards.json`（透過 `cache.ts`）——`cards-final.json` 沒有接到任何 route，只被幾個一次性腳本用到。
- 圖片絕不會直接把 TCGdex CDN 網址回傳給前端；`buildImageUrl` 一律指向 `/api/images/{serie}/{setId}/{localId}/{high|low}`（`server/src/routes/images.ts`），由該路由代理到本地快取，找不到才 fallback 到 CDN。
- 卡片 ID 格式為 `{SetCode}-{Number}`（例如 `SV1V-001`）。**大致已解決**：`server/data/preset-decks.json` 過去使用舊版爬蟲 ID 格式（例如 `scr-14129`），與 TCGdex 目前的 ID 對不上；56 副預組牌組已全數改指到 Standard-legal、現行格式的印刷版本（commit `819a278`），現在裡面沒有任何舊格式 ID。還沒解決的部分：在那次修復「之前」使用者自己存到 `localStorage` 的舊牌組可能仍帶有舊格式 ID——`deckStore.validateDeck` 已經容忍這種情況（見下方「前端結構」），效果是靜默跳過該卡而不是崩潰。完整背景與候選解法見 `ptcg-game/AGENTS.md`（它的「已知問題 & Backlog」段落仍然準確；但檔案開頭的架構描述是舊版寫的，跟現在的 Koa/boardgame.io/HeuristicAI 架構對不上，不要採信）。
- **姊妹印刷版本間的資料缺口**：`cards.json` 裡個別卡片印刷版本會漏掉 `abilities`/`attacks` 欄位——即使同一張卡的其他印刷版本（同名同副屬性同 HP）有完整資料，UI 仍會照 `cardData.abilities` 顯示效果文字，遊戲邏輯查不到資料就等於該效果被無聲跳過。不是全部同名卡都能直接互相回填：同名卡在不同印刷版本有時真的是完全不同的設計。`find-sibling-data-gaps.ts`（見下方「卡片邏輯覆蓋率稽核工具」）會比對 HP + 招式簽章找出候選，但它給的信心標籤不是最終定論——**真正可靠的驗證方法是檢查是否有「反向缺口」**：如果印刷版本 A 缺 `abilities`、而提議拿來當來源的印刷版本 B 缺 `attacks`，且 A 剛好有 B 缺的那份 `attacks`，這種互補關係就能反向印證兩者其實是同一個真實設計，只是被拆成兩份不完整的爬蟲資料（實際案例：這次 session 用這個方法回填了 小火龍 `MC-083`、金屬怪 `SV9-038`、振翼髮 `SV8-059`——三張單看招式簽章比對都只有「medium confidence」，但來源印刷版本上找得到反向缺口，才確認可以安全回填）。如果同 HP 配對既沒有反向缺口、招式簽章也對不上，就不要自動套用，只能當作需要人工查證的線索。

### 反覆踩過的坑（明確規則——每一條都對應一個真的出過的 bug）
- **修正落到磁碟上，不等於落到使用者正在測的那個 app 裡。** 伺服器啟動時把 `cards.json` 讀進記憶體後就不會再重讀——`tsx watch` 只監看被 import 的 TS 模組，資料修補永遠不會熱生效；而一個不小心沒帶 `watch` 啟動的伺服器（真的發生過：一個純 `tsx src/index.ts` 跑了半天）連程式碼修改都不會套用。最慘的一次：一整天的修正——資料回填、神奇糖果 gate、盈溢祈願、先手抽牌——全部只用腳本對磁碟驗證過，而使用者那個 02:53 啟動的伺服器一直在跑修正前的行為，於是每一項都被回報「還是壞的」。規則：改了伺服器程式碼或 `server/data/*.json` 之後，先確認執行中的 process 真的重啟了（不確定就查 PID 的啟動時間），再**透過 live API**（`curl localhost:3001/api/...`）或真實 UI 驗證修正，才能回報修好。前端修正另外要請使用者強制重新整理瀏覽器，排除舊分頁。
- **爬蟲抓到的中文名稱可能帶一個看不見的前導零寬字元**（例如 `‌寶可夢中心的姐姐` 其實混了一個零寬字元進去，跟乾淨的 `寶可夢中心的姐姐` 不相等），特性名稱還可能夾帶一段實體的 `[特性] ` 前綴文字。任何要拿卡片/特性名稱去跟登記表 key 做比對或查找的程式碼，**都必須**先過 `normalizeCardName`/`normalizeAbilityName`（`server/src/game/effects/types.ts`）。漏掉這一步會讓查找靜默失敗——因為那個零寬字元不會印出來，測試時完全看不出來——之前也因此讓 `coverage-report.ts` 低估了真實覆蓋率（37/287 個特性其實已經有實作，卻因為比對原始字串而被回報成只有 18/287，見 commit `a0cde71`）。之後寫新腳本，只要涉及依卡片/特性名稱做分組、比對、去重，都要先過這個 helper，不要直接比對原始字串。
- **在相信「未覆蓋」清單之前，先確認工具真的檢查了所有相關登記表。** 特性分散在兩個登記表——觸發型的 `abilityEffects`（`abilities.ts`）跟被動型的 `PASSIVE_ABILITY_NAMES`（`passiveAbilities.ts`）——`coverage-report.ts` 目前兩個都有查（`isAbilityCovered()`），也有先正規化名稱；如果之後新增別支 coverage 腳本、或修改這一支，記得繼續透過 normalizer 檢查兩個登記表，不然數字會退回前一條講的低估 bug。
- **每個回合開始都要抽牌，包含先手玩家的第一回合。** 先手的代價是「不能攻擊／不能進化／不能用支援者」這些限制（`validation.ts` 的 `isFirstTurnOfGame`），**不是**少抽一張牌。三份回合生命週期的複製程式碼原本都寫成 `G.phase = turn === 1 ? 'main' : 'draw'`，把 `setup()` 已經設好的 `'draw'` 蓋掉——結果 AI 對 AI 時先手玩家永遠不抽牌，人類對戰卻會抽（人類的第一回合是走 `choose_active` → `chooseActive` 設 `phase='draw'` 這條路），也就是兩個引擎對同一條核心規則**默默地各做各的**。已用參考網站確認：它的記錄是 `Setup 完成！<先手> 行動中。` 緊接著就是 `<先手> 抽了 1 張牌（手牌 7 張）`，而且先手後手都會抽。以後動到回合生命週期時，三份複製（`battleRunner.ts`、`humanBattle.ts`、`PtcgGame.ts`）要一起改並互相對照——「只有其中一份是對的」正是這裡的典型失敗模式。
- **就算「已覆蓋」的程式碼，也可能藏著沒接上的死程式碼。** `getToolHpBonus()` 存在、也能被單獨查詢用了一段時間，但一直沒有任何地方真的從 `effectiveMaxHp()` 呼叫它——欄位有登記、查詢函式本身也沒問題，但兩者沒接上，導致這個效果在真正對戰中悄悄地什麼都不做（見 commit `128b755`）。coverage 百分比只能證明某個 handler「存在」，不能證明它真的被接進對戰會跑到的程式路徑——新增效果 hook 時，要親自追一下呼叫它的那個點在哪裡，不要以為登記完、coverage 工具就會幫你抓到沒接線的問題（它抓不到）。

### 前端結構
- `client/src/stores/` — Zustand stores：`cardStore`（卡片目錄/搜尋狀態）、`deckStore`（牌組編輯器：`addCard`、`validateDeck` — 60 張牌 / 同名卡最多 4 張規則，一般能量除外、`saveDeck`/`loadDeck` 存取 `localStorage`）、`gameStore`（對戰 session 狀態）。
- `client/src/pages/` — `Home`、`CardBrowser`、`DeckBuilder`、`Battle`（人類對 AI，溝通對象為 `humanBattle.ts`）、`BattleLab`（AI 對 AI 模擬測試介面，溝通對象為 `battles.ts`）。
- `deckStore.validateDeck` 遇到目前卡片目錄中找不到的 ID 會直接跳過該卡，而不是報錯失敗 — 這是刻意設計，用來容忍上述的舊版 ID 牌組，不要把它「修正」成會 throw 的版本。

### 一次性資料腳本
`server/src/scripts/` 存放匯入/爬取/合併/修補用的腳本（例如 `scrape-official-standard.ts`、`merge-all-official.ts`、`patch-ace-spec.ts`），用來建立/修復 `server/data/*.json` 的資料快照。這些腳本是用 `tsx` 手動執行的，不屬於日常開發流程的一部分 — 執行前請先讀過該腳本的內容，因為有些會直接就地修改 `server/data/*.json`。臨時的一次性驗證/稽核腳本用完即刪（慣例用 `_` 前綴命名，例如 `_verify-xxx.ts`），不要留在 repo 裡。

### 卡片邏輯覆蓋率稽核工具
用來找「卡片文字寫了效果、但遊戲裡沒有真的執行」這類不會讓遊戲崩潰、也不會被一般測試發現的隱藏漏洞，分兩支互補的腳本（都用 `npx tsx src/scripts/<name>.ts` 執行，在 `server/` 目錄下）：
- `coverage-report.ts` — 找「資料有寫、程式沒接」：比對 `abilityEffects`/`PASSIVE_ABILITY_NAMES`/`trainerEffects`/`attackEffects`（`server/src/game/effects/{abilities,passiveAbilities,trainers,attacks}.ts`）是否涵蓋 `cards.json` 裡實際出現過的特性/訓練家/攻擊名稱（透過 `normalizeCardName`/`normalizeAbilityName` 比對，見「反覆踩過的坑」），依重印次數排序輸出，結果存到 `data-scraped/coverage-uncovered-*.json`。
- `find-sibling-data-gaps.ts` — 找「資料本身就漏寫」：把同名卡分組，比對是否有印刷版本缺 `abilities`/`attacks` 而其他印刷版本（HP 相符，且雙方都有招式資料時招式簽章也相符）有，輸出候選清單到 `data-scraped/sibling-data-gaps.json`。**這支工具只能抓到「有姊妹版本可比對」的缺口**，孤例卡片抓不到。它給的 `confidence: 'high'` 代表招式簽章完全相符；`'medium'` 代表沒辦法這樣交叉驗證——`'medium'` 的候選在回填前，要用「卡片資料流程」段落講的反向缺口檢查法手動核對。

- `audit-vs-reference.ts` — 找「真實對局觸發了這個效果，但我們什麼都不會做」：讀取參考網站自己的事件記錄（由 `autoplay.mjs`／`batch.mjs` 擷取到 `.playwright-mcp/games`，見「專案概述」裡參考網站那一段），把實際觸發過的每個特性／訓練家／招式拿去比對我們的登記表。輸出：`data-scraped/reference-audit.md`。這是三者中訊號最強的一支——不像另外兩支，它只回報**真的被打出來過**的效果，所以結果不會是紙上談兵。220 場基準線：特性／訓練家 0 個未覆蓋，招式文字 13 個未覆蓋。

`cards.json` 每次重新抓取/enrich 後這兩份報告就可能過期，改動卡片效果實作或懷疑有資料缺口時應該重跑一次。回填完之後，建議用 `battleRunner.ts` 針對真正含有這些卡的牌組小規模跑幾場（場數見「成本/情境使用紀律」），不要只相信報告本身——這只能確認資料不會讓引擎崩潰，不能證明一個「新實作」的效果會像參考網站那樣真的觸發（要驗證這個，去參考網站實測）。

### 官網文字爬蟲（`scrape-all-official-data.ts` / `scrape-missing-card-data.ts`）
獨立於 TCGdex 的第二個卡片資料來源：直接對 `asia.pokemon-card.com/tw/card-search` 逐張抓 HTML（用 `cheerio` 解析），寫到 `server/data/scraped-cards-all.json`。從來沒有做過影像辨識/OCR——純文字 HTML 解析。特性跟招式在官網頁面上是同一種 `.skill` 區塊，差別只在特性的 `.skillName` 會多一個 `[特性] ` 前綴（共用的 `normalizeCardName` 修法見「反覆踩過的坑」——早期這裡有一個過度寬鬆的 `[` 前綴過濾器，曾經把所有特性資料一起誤刪，已修好）。`reconcile-official-data.ts` 把這份資料的 `rarity`/`legalities.standard` 合併回 `cards.json`；`backfill-attacks-from-official.ts`/`refetch-abilities-from-official.ts` 則是把 `attacks`/`abilities` 回填進去，兩者都沿用同一套「set+number 為主 key、退而求其次用不重複姓名比對、比對不到或有歧義就跳過不猜」的謹慎比對邏輯——修改比對邏輯或新增類似的回填腳本時，應該重用而非重新發明這套 key()/parseNumerator()/parseTcgdexNumber() 寫法。

## Git 工作流程

這個 repo 的歷史是由很多顆小而聚焦的 commit 組成的（看 `git log` 就知道——例如每一批特性覆蓋率、每一個 bug 修復都是獨立一顆 commit）。請延續這個慣例：
- 完成並驗證完一個獨立的工作單元後（例如：一個腳本驅動的資料修復 + 它的驗證跑批、一個 bug 修復 + 確認可運作），就在本機 commit 掉，不要留著已完成、已驗證的工作不 commit 就繼續做下一件事。這是針對本專案的一個標準例外，蓋過預設的「只有使用者要求才 commit」規則。
- 這個例外**只涵蓋本機 commit**。Push，以及任何會動到共用/遠端狀態的操作，仍然每次都要先問過使用者——這份文件不會預先授權那些動作。
- 一般的衛生習慣照舊：commit 訊息要講清楚「為什麼」而不只是「做了什麼」、staging 前檢查一下 `git status`/`git diff`、絕不加 `--no-verify` 或繞過簽章、staging 任何看起來可能含機密資訊的檔案前先確認內容。

## 成本 /情境使用紀律

此專案的使用者對 token 用量敏感，長時間 session 容易不知不覺耗盡額度。請遵守：
- 回覆盡量精簡，不要重複輸出已經在對話中出現過的內容（例如剛編輯過的檔案，Edit 成功後不需要再 Read 一次確認）。
- 避免重新讀取已經在上下文中的檔案；需要引用時直接用 `file:line` 標記即可。
- 對話變長時（尤其是連續多輪工具呼叫之後），主動建議使用者執行 `/compact`，不要等到被 `.claude/hooks/context-guard.js` 這個 PreToolUse hook 擋下來才處理（該 hook 會在 transcript 超過約 10 萬 token 時警告、超過約 18 萬 token 時直接封鎖 Bash/Edit/Write，並要求先 `/compact`）。
- 大型一次性稽核/爬蟲腳本盡量寫在 scratchpad 或 `server/src/scripts/` 裡執行完就刪除（如既有慣例），不要把大量中間產出貼回對話內容。
- AI 對戰壓力測試（`battleRunner.ts`/BattleLab）的場數要跟改動的影響範圍成比例：單純新增、不牽動既有程式路徑的小改動（新特性 handler、資料回填）抽測幾副牌即可，不必每次都跑滿 56 副預組牌組；牽動共用邏輯（進化系統、AI 評分等）的改動才需要全套跑一輪。用 `HeuristicAI`/`RandomAI`/`MockAI` 互打不會呼叫 Anthropic API、不花真正的 token，但終端機輸出仍會佔用對話上下文，保持輸出精簡（進度列 + 摘要）。
