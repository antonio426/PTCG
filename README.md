# PTCG Game

PTCG Game 是一個以 Pokémon TCG 風格為靈感的卡牌對戰專案，包含前端使用者介面、後端遊戲伺服器與共用型別/常數。

## 專案特色

- 卡片瀏覽與牌組建構
- 對戰畫面與回合流程
- 以 TypeScript 建構的前後端共用邏輯
- 使用 React + Vite 建立前端介面
- 使用 Koa + Boardgame.io 提供遊戲伺服器

## 技術堆疊

- 前端：React、Vite、Tailwind CSS、Zustand、React Router
- 後端：Node.js、TypeScript、Koa、Boardgame.io
- 共用：TypeScript 型別與常數

## 專案結構

- client：前端應用程式
- server：後端遊戲伺服器與 API
- shared：共用型別與常數

## 開發環境需求

- Node.js 18+
- npm 9+

## 安裝與啟動

進入專案根目錄後，安裝依賴：

```bash
cd ptcg-game
npm install
```

啟動開發環境：

```bash
npm run dev
```

這會同時啟動前端與後端服務。

### Windows PowerShell 方案

也可以直接執行：

```powershell
./start-dev.ps1
```

## 預設網址

- 前端：http://localhost:5173
- 後端：http://localhost:3001

## 常用指令

```bash
npm run dev
npm run build
```

## 備註

- 前端會透過 Vite 的代理設定連到後端 API。
- 如果你想要進一步擴充卡牌資料、圖片下載或對戰邏輯，這個專案目前的 server 與 shared 目錄已提供基礎結構。
