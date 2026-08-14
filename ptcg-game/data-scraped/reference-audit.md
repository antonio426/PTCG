# 參考站對局稽核報告（vs ptcg-tw-sim.com）

- 對局數：220（完成 146）
- 參考站實際觸發過的具名效果：122（特性/訓練家/其他）
- 參考站實際使用過的招式：82
- **我方引擎沒有對應處理的：13**

## 我方未覆蓋（依出現次數排序）

- `太陽岩::宇宙光束` ×74 — Attack — TEXT NOT HANDLED: 若自己的備戰區沒有「月石」，則這個招式失敗。這個招式的傷害不計算弱點・抵抗力。
- `竹蘭的花岩怪::激怒咒詛` ×51 — Attack — TEXT NOT HANDLED: 造成自己的備戰區的所有「竹蘭的寶可夢」身上放置的傷害指示物的數量×10點傷害。這個招式的傷害不計算弱點。
- `比克提尼::V戰力` ×51 — Attack — TEXT NOT HANDLED: 若自己的備戰寶可夢為4隻以下，則這個招式失敗。
- `破破舵輪::悔念錨` ×20 — Attack — TEXT NOT HANDLED: 若自己的棄牌區有4張以上擁有特性「化隱」的寶可夢卡，則增加140點傷害。
- `凱路迪歐ex::疾風直撞` ×15 — Attack — TEXT NOT HANDLED: 在這個回合，若從備戰區將這隻寶可夢放置於戰鬥場，則增加90點傷害。
- `超級路卡利歐ex::波動突刺` ×12 — Attack — TEXT NOT HANDLED: 從自己的棄牌區選擇最多3張「基本【鬥】能量」卡，以任意方式附於備戰寶可夢身上。
- `熔蟻獸::舔舔捕捉` ×11 — Attack — TEXT NOT HANDLED: 從自己的牌庫選擇【火】寶可夢卡與「基本【火】能量」卡合計最多3張，在給對手看過後加入手牌。並且重洗牌庫。
- `胖嘟嘟ex::力量壓制` ×6 — Attack — TEXT NOT HANDLED: 若身上附有的能量比使用這個招式所需的能量多2個，則增加80點傷害。
- `喵喵ex::夾尾巴逃跑` ×4 — Attack — TEXT NOT HANDLED: 將這隻寶可夢與附加的卡，全部放回手牌。
- `桃歹郎ex::煩煩爆炸` ×4 — Attack — TEXT NOT HANDLED: 造成對手已經獲得的獎賞卡的張數×60點傷害。
- `超級噴火龍Xex::烈獄狂火X` ×4 — Attack — TEXT NOT HANDLED: 將自己的場上寶可夢身上附加的任意數量的【火】能量卡丟棄，造成其張數×90點傷害。
- `超級龍頭地鼠ex::極限鑽` ×3 — Attack — TEXT NOT HANDLED: 若身上附有的能量比使用這個招式所需的能量多2個，則增加130點傷害。
- `詛咒娃娃::玩偶捕捉` ×3 — Attack — TEXT NOT HANDLED: 若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。

## 傷害計算式（參考站顯示的公式）

- `鋼` ×244
- `鬥` ×225
- `火` ×179
- `惡` ×173
- `草` ×158
- `超` ×127
- `N(基礎) ×N(弱點) = N` ×72
- `雷` ×56
- `N(基礎) -N(屬性相剋) = N` ×17
- `中毒` ×12
- `水` ×11
- `N(基礎) -N(鑽石膜) = N` ×10
- `N(基礎) +N(極限腰帶) = N` ×8
- `N(基礎) +N(力量蛋白飲) = N` ×7
- `基礎` ×3
- `N(基礎) +N(輝煌聲援) -N(屬性相剋) = N` ×3
- `[N(基礎) +N(力量蛋白飲)] ×N(弱點) = N` ×2
- `N(基礎) +N(輝煌聲援) +N(輝煌聲援) -N(屬性相剋) = N` ×1
- `[N(基礎) +N(輝煌聲援) +N(力量蛋白飲)] ×N(弱點) = N` ×1
- `N(基礎) +N(輝煌聲援) +N(力量蛋白飲) = N` ×1
- `N(基礎) +N(力量蛋白飲) -N(屬性相剋) = N` ×1
- `N(基礎) +N(輝煌聲援) +N(輝煌聲援) +N(力量蛋白飲) -N(屬性相剋) = N` ×1
- `混亂` ×1
- `N(基礎) +N(空手道王演練) = N` ×1
- `N(基礎) +N(激動力量) = N` ×1

## 狀態異常相關敘述

- `支配鎖鏈：選 N 隻備戰惡屬性寶可夢換出場，並中毒` ×209
- `中毒：超級耿鬼ex 受到 N 傷害！` ×42
- `中毒：阿勃梭魯 受到 N 傷害！` ×39
- `中毒：吉雉雞ex 受到 N 傷害！` ×36
- `中毒：勾魂眼 受到 N 傷害！` ×34
- `中毒：無極汰那 受到 N 傷害！` ×34
- `中毒：飯匙蛇 受到 N 傷害！` ×30
- `中毒：鬼斯 受到 N 傷害！` ×26
- `中毒：毒電嬰 受到 N 傷害！` ×22
- `中毒：鬼斯通 受到 N 傷害！` ×19
- `中毒：超級噴火龍Xex 受到 N 傷害！` ×19
- `中毒：超級巨牙鯊ex 受到 N 傷害！` ×18
- `中毒：利牙魚 受到 N 傷害！` ×16
- `中毒：顫弦蠑螈 受到 N 傷害！` ×14
- `支配鎖鏈：將 吉雉雞ex 換到備戰區，派出 飯匙蛇 到戰鬥場（中毒）` ×11
- `支配鎖鏈：將 超級耿鬼ex 換到備戰區，派出 阿勃梭魯 到戰鬥場（中毒）` ×10
- `支配鎖鏈：將 阿勃梭魯 換到備戰區，派出 超級耿鬼ex 到戰鬥場（中毒）` ×10
- `支配鎖鏈：將 勾魂眼 換到備戰區，派出 超級耿鬼ex 到戰鬥場（中毒）` ×9
- `支配鎖鏈：將 超級巨牙鯊ex 換到備戰區，派出 吉雉雞ex 到戰鬥場（中毒）` ×9
- `支配鎖鏈：將 飯匙蛇 換到備戰區，派出 吉雉雞ex 到戰鬥場（中毒）` ×9
- `支配鎖鏈：將 超級耿鬼ex 換到備戰區，派出 勾魂眼 到戰鬥場（中毒）` ×8
- `支配鎖鏈：將 超級耿鬼ex 換到備戰區，派出 無極汰那 到戰鬥場（中毒）` ×8
- `中毒：黑暗鴉 受到 N 傷害！` ×8
- `支配鎖鏈：將 無極汰那 換到備戰區，派出 超級耿鬼ex 到戰鬥場（中毒）` ×7
- `支配鎖鏈：將 吉雉雞ex 換到備戰區，派出 超級巨牙鯊ex 到戰鬥場（中毒）` ×5

## 已覆蓋（抽樣前 40）

- `搜到` ×680 — engine-message — not a card name
- `高級球` ×550 — Trainer — trainerEffects
- `支配鎖鏈` ×418 — Ability — abilityEffects
- `中毒` ×367 — engine-message — not a card name
- `莉莉艾的決意` ×252 — Trainer — trainerEffects
- `🪙 擲硬幣` ×220 — engine-message — not a card name
- `寶可平板` ×217 — Trainer — trainerEffects
- `腎上腺腦力` ×155 — Ability — abilityEffects
- `艾莉絲的鬥志` ×152 — Trainer — trainerEffects
- `金屬信號` ×128 — Ability — abilityEffects
- `能量轉移` ×126 — Trainer — trainerEffects
- `金屬製造者` ×113 — Ability — abilityEffects
- `牌庫搜尋` ×112 — engine-message — not a card name
- `放到備戰區` ×107 — engine-message — not a card name
- `惡棍衝天` ×104 — Ability — abilityEffects
- `偵查指令` ×100 — Ability — abilityEffects
- `激動渦輪` ×96 — Ability — abilityEffects
- `老大的指令` ×95 — Trainer — trainerEffects
- `氣球` ×84 — Trainer(Tool/Stadium) — generic tool/stadium
- `從棄牌取回` ×78 — engine-message — not a card name
- `夜間擔架` ×74 — Trainer — trainerEffects
- `宇宙光束` ×74 — engine-message — not a card name
- `好友寶芬` ×70 — Trainer — trainerEffects
- `機關槍合擊` ×67 — engine-message — not a card name
- `碧綠之舞` ×66 — Ability — abilityEffects
- `天空搬運` ×66 — Ability — abilityEffects
- `赤松` ×64 — Trainer — trainerEffects
- `捕蟲組合` ×64 — Trainer — trainerEffects
- `🤖 AI 對手 打出競技場` ×63 — engine-message — not a card name
- `逃跑抽出` ×62 — Ability — abilityEffects
- `戰鬥鑼` ×59 — Trainer — trainerEffects
- `鬼斯::咒怨一下` ×58 — Attack — plain damage (no text)
- `寶可裝置3.0` ×56 — Trainer — trainerEffects
- `使者衝刺` ×54 — Ability — abilityEffects
- `含羞苞::癢癢花粉` ×53 — Attack — generic template
- `癢癢花粉` ×52 — engine-message — not a card name
- `琵魯` ×51 — Trainer — trainerEffects
- `激怒咒詛` ×51 — engine-message — not a card name
- `V戰力` ×51 — engine-message — not a card name
- `力量蛋白飲` ×49 — Trainer — trainerEffects