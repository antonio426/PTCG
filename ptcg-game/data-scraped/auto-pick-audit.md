# Auto-pick audit (Standard-legal)

Attacks whose text says 選擇 but whose effect the engine picks at random.
Auto-picking outcome fields detected in attackResolution.ts: attachAllBasicEnergyFromHand, attachOpponentDiscardEnergyToTheirPokemonCount, benchSplashDamage, benchSubtypeTargetDamage, bothAttachHandBasicsCount, coinPerOpponentPokemonDamage, copyFromOpponentDeckTop, deckSearchAnyCardsToTopOfDeck, deckSearchTypedEnergyToAllBenchEach, devolveOpponentToHandCount, discardAllSelfEnergyForCounters, discardNamedToDeckCountersOnOpponent, discardOpponentHandDownTo, discardRandomSelfHandCount, flipCoinsDiscardSelfEnergyByTailsCount, flipUntilTailsDiscardOpponentEnergy, healBenchNamedAmount, healBenchTypedAmount, healRandomOwnDamagedAmount, koOpponentBasicCoinSplit, koOpponentWithCountersAtLeast, koRandomOpponent, multiTargetSelfBenchFlatDamage, opponentBenchDamageScaledSplash, opponentSpecialEnergyHolderSplash, optionalEnergyToDeckForBenchDamage, placeCountersOnMultipleOpponents, placeCountersOnRandomOpponent, quadrupleCountersOnOpponents, revealTopAttachEnergiesCount, selfSwitchToRandomBench, shuffleRandomOpponentHandCardIntoDeck, shuffleRandomOpponentHandCardsIntoDeckCount

## texts (17)

- `厄鬼椪 水井面具ex::激流水泵` (SV6-038, 5 prints) — auto-picked: optionalEnergyToDeckForBenchDamage
  > 若希望，選擇3個這隻寶可夢身上附加的能量，放回牌庫並重洗。這個情況下，對手的1隻備戰寶可夢也受到120點傷害。[在備戰區不計算弱點・抵抗力。]
- `熔蟻獸::滑燒火焰` (SV5K-009, 2 prints) — auto-picked: flipCoinsDiscardSelfEnergyByTailsCount
  > 擲3次硬幣，選擇與反面出現的次數相同數量的這隻寶可夢身上附加的能量，將其丟棄。
- `拉普拉斯ex::海紋石之雨` (SV7-019, 2 prints) — auto-picked: revealTopAttachEnergiesCount
  > 查看自己的牌庫上方20張卡，從其中選擇任意數量的能量卡，以任意方式附於自己的寶可夢身上。將剩餘卡放回牌庫並重洗。
- `詛咒娃娃::詛咒言語` (SV9-036, 2 prints) — auto-picked: shuffleRandomOpponentHandCardsIntoDeckCount
  > 對手選擇3張對手自己的手牌，放回牌庫並重洗。
- `冰伊布ex::藍柱石` (SV8a-041, 2 prints) — auto-picked: koOpponentWithCountersAtLeast
  > 選擇1隻對手的身上放置有6個傷害指示物的寶可夢，將其【昏厥】。
- `步哨鼠::臨檢` (M4-069, 2 prints) — auto-picked: shuffleRandomOpponentHandCardsIntoDeckCount
  > 擲3次硬幣。若出現正面，則查看對手的手牌，從其中選擇與正面出現的次數相同數量的卡，放回對手的牌庫並重洗。
- `火箭隊的貓老大ex::高傲指令` (MC-560, 2 prints) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `超能豔鴕::奧密之眼` (SV7a-023, 1 print) — auto-picked: devolveOpponentToHandCount
  > 選擇1隻對手的進化寶可夢，移除1張「進化卡」使其退化。將移除的卡放回對手的手牌。
- `阿羅拉 椰蛋樹ex::熱帶狂燒` (SV7a-040, 1 print) — auto-picked: attachAllBasicEnergyFromHand
  > 從自己的手牌選擇任意數量的基本能量卡，以任意方式附於自己的寶可夢身上。
- `阿羅拉 椰蛋樹ex::嗡嗡榍石` (SV7a-040, 1 print) — auto-picked: koOpponentBasicCoinSplit
  > 擲1次硬幣若為正面，則將對手的戰鬥場的【基礎】寶可夢【昏厥】。若為反面，則選擇1隻對手的備戰區的【基礎】寶可夢，將其【昏厥】。
- `帝牙盧卡::時間掌控` (SV7a-042, 1 print) — auto-picked: deckSearchAnyCardsToTopOfDeck
  > 從自己的牌庫任意選擇2張卡。重洗剩餘牌庫，將所選的卡以任意順序排列，放回牌庫上方。
- `塗標客::惡作劇作畫` (SV8-074, 1 print) — auto-picked: attachOpponentDiscardEnergyToTheirPokemonCount
  > 從對手的棄牌區選擇最多3張能量卡，以任意方式附於對手的寶可夢身上。
- `<火箭隊的>貓老大ex::高傲指令` (SV10-079, 1 print) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `<火箭隊的>多邊獸::駭客攻擊` (SV10-081, 1 print) — auto-picked: discardRandomSelfHandCount
  > 選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。
- `洛奇亞ex::破壞潮旋` (SVM-097, 1 print) — auto-picked: flipUntilTailsDiscardOpponentEnergy
  > 擲硬幣直到出現反面，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。
- `信使鳥::幸福禮物` (M4-018, 1 print) — auto-picked: bothAttachHandBasicsCount
  > 雙方玩家若希望，各自從自己的手牌選擇最多3張基本能量卡，以任意方式附於自己的寶可夢身上。（對手先選擇。）
- `大電海燕ex::迴旋充能` (SV-P-100, 1 print) — auto-picked: selfSwitchToRandomBench
  > 將這隻寶可夢與備戰寶可夢互換。‌然後，從自己的手牌選擇最多2張「基本【雷】能量」卡，附於這隻寶可夢身上。