# Auto-pick audit (Standard-legal)

Attacks whose text says 選擇 but whose effect the engine picks at random.
Auto-picking outcome fields detected in attackResolution.ts: attachAllBasicEnergyFromHand, attachNamedFromHandHealFull, attachOpponentDiscardEnergyToTheirPokemonCount, benchSplashDamage, benchSubtypeTargetDamage, bothAttachHandBasicsCount, copyDefenderRandomAttack, copyFromOpponentDeckTop, deckSearchAnyCardToHand, deckSearchAnyCardsToTopOfDeck, deckSearchToolToHand, deckSearchTypedEnergyToAllBenchEach, deckSearchTypedEnergyToOwnPokemonCount, deckSearchTypedPokemonOrEnergyToHand, deckSearchTypedPokemonToHandCount, devolveOpponentToHandCount, discardNamedToDeckCountersOnOpponent, discardOpponentHandDownTo, discardPileSearchAnyEnergyToSelf, discardPileSearchAnyToHandCount, discardPileSearchFamilyToBenchCount, discardPileSearchPokemonToHandCount, discardPileSearchSupporterToHand, discardRandomOpponentHandCount, discardRandomSelfHandCount, flipCoinsDiscardSelfEnergyByTailsCount, flipUntilTailsDiscardOpponentEnergy, healBenchNamedAmount, healBenchTypedAmount, healRandomOwnDamagedAmount, koOpponentBasicCoinSplit, koOpponentWithCountersAtLeast, koRandomOpponent, moveOpponentEnergyToTheirBench, moveSelfEnergyToRandomBench, moveSelfEnergyToRandomBenchCount, multiTargetOpponentFlatDamage, multiTargetSelfBenchFlatDamage, opponentBenchDamageScaledSplash, opponentNamedFlatDamage, opponentSpecialEnergyHolderSplash, optionalEnergyToDeckForBenchDamage, placeCountersOnMultipleOpponents, placeCountersOnRandomOpponent, quadrupleCountersOnOpponents, randomOpponentHandCardToDeckBottom, revealTopAttachEnergiesCount, selfSwitchToRandomBench, shuffleOpponentBenchExceptCount, shuffleRandomOpponentHandCardIntoDeck, shuffleRandomOpponentHandCardsIntoDeckCount

## texts (63)

- `遠古巨蜓ex::噴射旋風` (SV9a-003, 5 prints) — auto-picked: moveSelfEnergyToRandomBenchCount
  > 選擇3個這隻寶可夢身上附加的能量，改附於1隻備戰寶可夢身上。
- `夜巡靈::前往渡魂` (SV6a-018, 5 prints) — auto-picked: discardPileSearchFamilyToBenchCount
  > 從自己的棄牌區選擇最多3張「夜巡靈」，放置於備戰區。
- `厄鬼椪 水井面具ex::激流水泵` (SV6-038, 5 prints) — auto-picked: optionalEnergyToDeckForBenchDamage
  > 若希望，選擇3個這隻寶可夢身上附加的能量，放回牌庫並重洗。這個情況下，對手的1隻備戰寶可夢也受到120點傷害。[在備戰區不計算弱點・抵抗力。]
- `波爾凱尼恩ex::高溫旋風` (SV9-017, 4 prints) — auto-picked: moveSelfEnergyToRandomBench
  > 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
- `鐵荊棘ex::伏特旋風` (SV5a-033, 4 prints) — auto-picked: moveSelfEnergyToRandomBench
  > 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
- `奧利瓦ex::油之機關槍` (SV10-012, 3 prints) — auto-picked: multiTargetOpponentFlatDamage
  > 選擇6次對手的寶可夢，對所選的所有寶可夢不計算弱點・抵抗力，造成其選擇次數×20點傷害。（1隻可選擇2次以上。）
- `焰后蜥::突然炙烤` (SV7-014, 3 prints) — auto-picked: discardRandomOpponentHandCount
  > 對手選擇對手自己的1張手牌，將其丟棄。在這個回合，若這隻寶可夢從「夜盜火蜥」進化，則再丟棄2張。
- `電電蟲::電電充能` (SV7-032, 3 prints) — auto-picked: deckSearchTypedEnergyToOwnPokemonCount
  > 從自己的牌庫選擇「基本【草】能量」卡與「基本【雷】能量」卡最多各2張，以任意方式附於自己的寶可夢身上。並且重洗牌庫。
- `倫琴貓ex::突刺目光` (SV6-041, 3 prints) — auto-picked: discardRandomOpponentHandCount
  > 查看對手的手牌，從其中選擇1張卡，將其丟棄。
- `耿鬼ex::戲法舞步` (SV5K-088, 3 prints) — auto-picked: moveOpponentEnergyToTheirBench
  > 若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。
- `超級耿鬼ex::空無強風` (MBG-003, 3 prints) — auto-picked: moveSelfEnergyToRandomBench
  > 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
- `熔蟻獸::舔舔捕捉` (MC-120, 3 prints) — auto-picked: deckSearchTypedPokemonOrEnergyToHand
  > 從自己的牌庫選擇【火】寶可夢卡與「基本【火】能量」卡合計最多3張，在給對手看過後加入手牌。並且重洗牌庫。
- `墓揚犬::恐怖啃咬` (MC-350, 3 prints) — auto-picked: shuffleRandomOpponentHandCardsIntoDeckCount
  > 擲硬幣直到出現反面，在不看手牌正面的情況下，從對手的手牌選擇與正面出現的次數相同數量的卡，查看那些卡的正面後放回對手的牌庫並重洗。
- `狡猾天狗::驅趕龍捲風` (SV5M-005, 2 prints) — auto-picked: shuffleOpponentBenchExceptCount
  > 選擇3隻對手的備戰寶可夢。然後，將對手的沒有選擇的所有備戰寶可夢與附加的卡，全部放回對手的牌庫並重洗。
- `葉伊布::嫩葉之恩` (SV5a-006, 2 prints) — auto-picked: attachNamedFromHandHealFull
  > 從自己的手牌選擇1張「基本【草】能量」卡，附於備戰寶可夢身上。然後，將附上那張卡的寶可夢的HP全部恢復。
- `巨牙鯊::咬棄` (SV5K-017, 2 prints) — auto-picked: discardRandomOpponentHandCount
  > 擲3次硬幣，在不看手牌正面的情況下，選擇與正面出現的次數相同數量的對手的手牌，將其丟棄。
- `拉普拉斯ex::海紋石之雨` (SV7-019, 2 prints) — auto-picked: revealTopAttachEnergiesCount
  > 查看自己的牌庫上方20張卡，從其中選擇任意數量的能量卡，以任意方式附於自己的寶可夢身上。將剩餘卡放回牌庫並重洗。
- `霏歐納::招喚` (SV5a-022, 2 prints) — auto-picked: discardPileSearchSupporterToHand
  > 從自己的棄牌區選擇1張支援者卡，在給對手看過後加入手牌。
- `土地雲::真氣之拳` (SV7a-030, 2 prints) — auto-picked: discardPileSearchAnyEnergyToSelf
  > 從自己的棄牌區選擇1張能量卡，附於這隻寶可夢身上。
- `詛咒娃娃::詛咒言語` (SV9-036, 2 prints) — auto-picked: shuffleRandomOpponentHandCardsIntoDeckCount
  > 對手選擇3張對手自己的手牌，放回牌庫並重洗。
- `冰伊布ex::藍柱石` (SV8a-041, 2 prints) — auto-picked: koOpponentWithCountersAtLeast
  > 選擇1隻對手的身上放置有6個傷害指示物的寶可夢，將其【昏厥】。
- `卡璞・鳴鳴::召喚雷電` (SV8-041, 2 prints) — auto-picked: deckSearchTypedPokemonToHandCount
  > 從自己的牌庫選擇最多2張【雷】寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。
- `皮可西::揮指` (SV6-046, 2 prints) — auto-picked: copyDefenderRandomAttack
  > 選擇1個對手的戰鬥寶可夢持有的招式，作為這個招式使用。
- `鐵轍跡::路徑輪` (SV5M-051, 2 prints) — auto-picked: moveSelfEnergyToRandomBench
  > 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
- `N的扒手貓::暗槓` (SV9-059, 2 prints) — auto-picked: randomOpponentHandCardToDeckBottom
  > 查看對手的手牌，從其中選擇1張卡，放回對手的牌庫下方。
- `肯泰羅::群起瞄準` (M4-067, 2 prints) — auto-picked: multiTargetOpponentFlatDamage
  > 選擇1隻對手的寶可夢，擲與自己的場上的，名稱中有「肯泰羅」的寶可夢的數量相同次數的硬幣。所選的寶可夢受到正面出現的次數×50點傷害。[在備戰區不計算弱點・抵抗力。]
- `步哨鼠::臨檢` (M4-069, 2 prints) — auto-picked: shuffleRandomOpponentHandCardsIntoDeckCount
  > 擲3次硬幣。若出現正面，則查看對手的手牌，從其中選擇與正面出現的次數相同數量的卡，放回對手的牌庫並重洗。
- `火箭隊的貓老大ex::高傲指令` (MC-560, 2 prints) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `信使鳥::急速之禮` (M1S-052, 2 prints) — auto-picked: deckSearchAnyCardToHand
  > 這個招式在先攻玩家的最初回合也可使用。從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。
- `黑眼鱷::勒緊` (SV11B-060, 2 prints) — auto-picked: discardRandomOpponentHandCount
  > 對手選擇1張對手自己的手牌，將其丟棄。
- `混混鱷::勒緊` (SV11B-061, 2 prints) — auto-picked: discardRandomOpponentHandCount
  > 對手選擇2張對手自己的手牌，將其丟棄。
- `流氓鱷::勒緊` (SV11B-062, 2 prints) — auto-picked: discardRandomOpponentHandCount
  > 對手選擇2張對手自己的手牌，將其丟棄。
- `小灰怪::挪動一下` (SV11B-126, 2 prints) — auto-picked: moveOpponentEnergyToTheirBench
  > 選擇1個對手的場上寶可夢身上附加的能量，改附於對手的其他寶可夢身上。
- `扒手貓::邪惡邀請` (SV11W-052, 2 prints) — auto-picked: deckSearchTypedPokemonToHandCount
  > 從自己的牌庫選擇最多3張【惡】寶可夢卡，在給對手看過後加入手牌。並且重洗牌庫。
- `長毛狗::氣味偵測` (SV11W-074, 2 prints) — auto-picked: discardPileSearchAnyToHandCount
  > 擲3次硬幣，從自己的棄牌區任意選擇最多與正面出現的次數相同數量的卡，在給對手看過後加入手牌。
- `葉伊布::嫩葉之恩` (SV8a-002, 1 print) — auto-picked: attachNamedFromHandHealFull
  > 從自己的手牌選擇1張「基本【草】能量」卡，附於備戰寶可夢身上。然後，將附上這些卡的寶可夢的HP全部恢復。
- `破破舵輪::救援船錨` (SV7a-004, 1 print) — auto-picked: discardPileSearchPokemonToHandCount
  > 從自己的棄牌區選擇最多2張寶可夢卡，在給對手看過後加入手牌。
- `鐵斑葉::補全之網` (SV5a-007, 1 print) — auto-picked: discardPileSearchPokemonToHandCount
  > 從自己的棄牌區選擇最多2張寶可夢卡，在給對手看過後加入手牌。
- `熔蟻獸::滑燒火焰` (SV5K-009, 1 print) — auto-picked: flipCoinsDiscardSelfEnergyByTailsCount
  > 擲3次硬幣，選擇與反面出現的次數相同數量的這隻寶可夢身上附加的能量，將其丟棄。
- `迷唇娃::樂呵呵之吻` (SV7a-018, 1 print) — auto-picked: deckSearchTypedEnergyToOwnPokemonCount
  > 從自己的牌庫選擇最多2張「基本【超】能量」卡，附於1隻備戰寶可夢身上。並且重洗牌庫。
- `超能豔鴕::奧密之眼` (SV7a-023, 1 print) — auto-picked: devolveOpponentToHandCount
  > 選擇1隻對手的進化寶可夢，移除1張「進化卡」使其退化。將移除的卡放回對手的手牌。
- `<火箭隊的>閃電鳥::阻礙之翼` (SV10-033, 1 print) — auto-picked: moveOpponentEnergyToTheirBench
  > 若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。
- `呆呆獸::垂尾巴` (SV7-038, 1 print) — auto-picked: discardPileSearchPokemonToHandCount
  > 從自己的棄牌區選擇1張寶可夢卡，在給對手看過後加入手牌。
- `阿羅拉 椰蛋樹ex::熱帶狂燒` (SV7a-040, 1 print) — auto-picked: attachAllBasicEnergyFromHand
  > 從自己的手牌選擇任意數量的基本能量卡，以任意方式附於自己的寶可夢身上。
- `阿羅拉 椰蛋樹ex::嗡嗡榍石` (SV7a-040, 1 print) — auto-picked: koOpponentBasicCoinSplit
  > 擲1次硬幣若為正面，則將對手的戰鬥場的【基礎】寶可夢【昏厥】。若為反面，則選擇1隻對手的備戰區的【基礎】寶可夢，將其【昏厥】。
- `<火箭隊的>謎擬Ｑ::扮晶晶酒` (SV10-042, 1 print) — auto-picked: copyDefenderRandomAttack
  > 選擇1個對手的戰鬥場的「太晶」寶可夢持有的招式，作為這個招式使用。
- `帝牙盧卡::時間掌控` (SV7a-042, 1 print) — auto-picked: deckSearchAnyCardsToTopOfDeck
  > 從自己的牌庫任意選擇2張卡。重洗剩餘牌庫，將所選的卡以任意順序排列，放回牌庫上方。
- `霜奶仙::彩色甜點` (SV7-044, 1 print) — auto-picked: deckSearchTypedPokemonToHandCount
  > 從自己的牌庫選擇與這隻寶可夢身上附加的基本能量卡相同屬性的寶可夢卡合計最多5張，在給對手看過後加入手牌。並且重洗牌庫。
- `甲賀忍蛙ex::忍之利刃` (SV5a-045, 1 print) — auto-picked: deckSearchAnyCardToHand
  > 若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。
- `美錄坦::搬運破爛` (SV7-070, 1 print) — auto-picked: deckSearchToolToHand
  > 從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。
- `塗標客::惡作劇作畫` (SV8-074, 1 print) — auto-picked: attachOpponentDiscardEnergyToTheirPokemonCount
  > 從對手的棄牌區選擇最多3張能量卡，以任意方式附於對手的寶可夢身上。
- `<火箭隊的>貓老大ex::高傲指令` (SV10-079, 1 print) — auto-picked: copyFromOpponentDeckTop
  > 將對手的牌庫上方10張卡翻到正面。若希望，選擇1個其中的寶可夢持有的招式，作為這個招式使用。將翻到正面的卡放回牌庫並重洗。
- `<火箭隊的>多邊獸::駭客攻擊` (SV10-081, 1 print) — auto-picked: discardRandomSelfHandCount, discardRandomOpponentHandCount
  > 選擇1張自己的手牌，將其丟棄。然後，對手選擇1張對手自己的手牌，將其丟棄。
- `超級阿勃梭魯ex::惡之鉤爪` (M1L-038, 1 print) — auto-picked: discardRandomOpponentHandCount
  > 查看對手的手牌，從其中選擇1張卡，將其丟棄。
- `洛奇亞ex::破壞潮旋` (SVM-097, 1 print) — auto-picked: flipUntilTailsDiscardOpponentEnergy
  > 擲硬幣直到出現反面，選擇與正面出現的次數相同數量的對手的戰鬥寶可夢身上附加的能量，將其丟棄。
- `詛咒娃娃::玩偶捕捉` (M5-032, 1 print) — auto-picked: deckSearchAnyCardToHand
  > 若希望，從自己的牌庫任意選擇1張卡加入手牌。並且重洗牌庫。
- `信使鳥::幸福禮物` (M4-018, 1 print) — auto-picked: bothAttachHandBasicsCount
  > 雙方玩家若希望，各自從自己的手牌選擇最多3張基本能量卡，以任意方式附於自己的寶可夢身上。（對手先選擇。）
- `超能妙喵::戲法舞步` (M4-037, 1 print) — auto-picked: moveOpponentEnergyToTheirBench
  > 若希望，選擇1個對手的戰鬥寶可夢身上附加的能量，改附於對手的備戰寶可夢身上。
- `雪絨蛾::極寒旋風` (M2a-041, 1 print) — auto-picked: moveSelfEnergyToRandomBenchCount
  > 選擇1個這隻寶可夢身上附加的【水】能量，改附於備戰寶可夢身上。
- `嗡蝠::搬運破爛` (M2a-130, 1 print) — auto-picked: deckSearchToolToHand
  > 從自己的牌庫選擇1張「寶可夢道具」卡，在給對手看過後加入手牌。並且重洗牌庫。
- `差不多娃娃::招喚` (SVM-106, 1 print) — auto-picked: discardPileSearchSupporterToHand
  > 從自己的棄牌區選擇1張支援者卡，在給對手看過後加入手牌。
- `謝米::能量反射` (SVM-105, 1 print) — auto-picked: moveSelfEnergyToRandomBench
  > 選擇1個這隻寶可夢身上附加的能量，改附於備戰寶可夢身上。
- `大電海燕ex::迴旋充能` (SV-P-100, 1 print) — auto-picked: selfSwitchToRandomBench
  > 將這隻寶可夢與備戰寶可夢互換。‌然後，從自己的手牌選擇最多2張「基本【雷】能量」卡，附於這隻寶可夢身上。