# PTCG 卡牌遊戲專案 — Agent Context

> **注意**：本檔案的架構描述寫於專案早期，已與現狀脫節（後端實為 Koa + boardgame.io、AI 有
> Random/Mock/Heuristic/Claude 四種、資料來源除 TCGdex 外還有官網爬蟲）。**當前準確的操作指南
> 是 `CLAUDE.md`**；本檔案保留作為歷史決策記錄與 Backlog 存檔。

## 專案概述

Pokémon TCG 卡牌遊戲，使用 Express + TypeScript 後端，React + TypeScript 前端。卡牌資料來源為 TCGdex v2 API（`https://api.tcgdex.net/v2/`）。

## 目錄結構

```
ptcg-game/
├── client/          # React 前端 (Vite)
│   ├── src/
│   │   ├── components/    # UI 元件
│   │   ├── stores/        # Zustand stores
│   │   ├── types/         # TypeScript 型別
│   │   └── utils/         # 共用工具
│   └── public/
├── server/          # Express 後端
│   ├── src/
│   │   ├── routes/        # API 路由
│   │   ├── services/      # 業務邏輯 (含 TCGdex API 整合)
│   │   └── types/         # 共用型別
├── shared/          # 前後端共用型別
└── data-scraped/    # 備用/已棄用資料
```

## 架構與決策記錄

### 卡片資料

- **來源**: TCGdex v2 API (`https://api.tcgdex.net/v2/zh-tw/`)
- **快取**: 伺服器啟動時會從 API 抓取所有卡片，存入記憶體（inMemoryCards）。
- **卡片 ID 格式**: `{SetCode}-{Number}`（例如 `SV1V-001`、`SVAW-001`）
- **Cards API**: `GET /api/cards` 回傳快取中的所有卡片，支援 `?limit=` 和 `?skip=` 分頁。
- **已知問題**: 卡牌資料大約 6000 張，下載約需 10-15 秒。

### 對戰系統

- **humanBattle.ts**: `POST /api/game/human/battle` — 創建對戰（需傳遞 `deckIds` 或 `deckId` 給雙方的牌組），啟動時呼叫 `fetchCardsByIds` 查詢卡片。
- **遊戲引擎**: 位於遊戲邏輯模組，支援回合制對戰、能量附著、招式使用、後備區切換。
- **AI**: 簡單的 MockAI，目前僅做隨機決策。
- **玩家順序**: `currentPlayer` 0 = 玩家，1 = AI。

### 牌組系統

- **deckStore.ts**: Zustand store 管理牌組編輯。
  - `addCard(id, skipCopyLimit)`: 加入卡片到當前編輯牌組
  - `validateDeck()`: 驗證是否符合 60 張規則 + 同名卡最多 4 張（一般能量除外）
  - `saveDeck()`: 儲存至 localStorage
  - `loadDeck(id)`: 從 localStorage 載入
- **preset-decks.json**: 內建預設牌組清單，使用卡片 ID 陣列。
- **DeckBuilder.tsx**: 牌組編輯器 UI，包含搜尋篩選、卡片清單、數量統計。

## 已知問題 & Backlog

### 1. 卡片 ID 格式不一致 (✅ 已完全解決，2026-08)

**問題**: `preset-decks.json` 使用舊格式 ID（`scr-14129`），但當前的 TCGdex 目錄使用 `SV*-*` 格式 ID（如 `SV1V-001`）。當對戰使用預設牌組時，`fetchCardsByIds` 因 cache 中沒有任何卡片的 id 為 `scr-14129` 而失敗。

**解決方式**（採用了候選解法 A + D 的組合）:
- (A) 預組：`audit-preset-decks-standard.ts --fix` 把 56 副預組全部重指到 Standard 印刷（commit 819a278）。
- (D) 使用者 localStorage 牌組：`printRemap.ts` + `POST /api/cards/remap` + deckStore 的一次性自動遷移（備份到 `ptcg-decks-pre-migration`、console 報告、`ptcg-decks-migrated-v1` 防重跑；commit f99f122、入口修正 60c2d52）。

### 2. 使用者 localStorage 牌組 ID 格式衝突 (已部分修復)

**問題**: 使用者 localStorage 中的牌組使用舊格式 ID（如 `scr-18382`）。當呼叫 `validateDeck` 時，`allCards.find(c => c.id === id)` 回傳 `undefined`，導致 Basic Energy 例外（4 張限制）無法觸發。

**修復**: `deckStore.ts` ~line 163 加入 `if (!card) continue;` — 若卡片 ID 在當前目錄中找不到，跳過此卡片的 4 張限制檢查。

## 重要技術細節

- **開發伺服器啟動**: 使用 `start-dev.ps1`（在 `ptcg-game/` 目錄執行）
- **TypeScript**: 前後端各自獨立編譯；後端用 `tsc`，前端用 `tsc --noEmit`
- **UI 框架**: React + TypeScript + Zustand（狀態管理）
- **運行端口**: 前端 dev server 與後端 Express 不同 port，前端 proxy API 請求到後端
