# Auto-pick audit (Standard-legal)

Attacks whose text says 選擇 but whose effect the engine picks at random.
Auto-picking outcome fields detected in attackResolution.ts: attachOpponentDiscardEnergyToTheirPokemonCount, benchSplashDamage, benchSubtypeTargetDamage, bothAttachHandBasicsCount, coinPerOpponentPokemonDamage, copyFromOpponentDeckTop, deckSearchTypedEnergyToAllBenchEach, discardAllSelfEnergyForCounters, discardNamedToDeckCountersOnOpponent, discardOpponentHandDownTo, discardRandomSelfHandCount, healBenchNamedAmount, healBenchTypedAmount, healRandomOwnDamagedAmount, koRandomOpponent, multiTargetSelfBenchFlatDamage, opponentBenchDamageScaledSplash, opponentSpecialEnergyHolderSplash, placeCountersOnMultipleOpponents, placeCountersOnRandomOpponent, quadrupleCountersOnOpponents, revealTopAttachEnergiesCount, selfSwitchToRandomBench, shuffleRandomOpponentHandCardIntoDeck

## texts (7)

- `拉普拉斯ex::海紋石之雨` (SV7-019, 2 prints) — auto-picked: revealTopAttachEnergiesCount
  > 查看自己的牌庫上方20張卡，從其中選擇任意數量的能量卡，以任意方式附於自己的寶可夢身上。將剩餘卡放回牌庫並重洗。
- `火箭隊的貓老大ex::高傲指令` (MC-560, 2 prints) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `塗標客::惡作劇作畫` (SV8-074, 1 print) — auto-picked: attachOpponentDiscardEnergyToTheirPokemonCount
  > 從對手的棄牌區選擇最多3張能量卡，以任意方式附於對手的寶可夢身上。
- `<火箭隊的>貓老大ex::高傲指令` (SV10-079, 1 print) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `<火箭隊的>多邊獸::駭客攻擊` (SV10-081, 1 print) — auto-picked: discardRandomSelfHandCount
  > 選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。
- `信使鳥::幸福禮物` (M4-018, 1 print) — auto-picked: bothAttachHandBasicsCount
  > 雙方玩家若希望，各自從自己的手牌選擇最多3張基本能量卡，以任意方式附於自己的寶可夢身上。（對手先選擇。）
- `大電海燕ex::迴旋充能` (SV-P-100, 1 print) — auto-picked: selfSwitchToRandomBench
  > 將這隻寶可夢與備戰寶可夢互換。‌然後，從自己的手牌選擇最多2張「基本【雷】能量」卡，附於這隻寶可夢身上。