# Effect trigger audit

Each check mirrors a bug this repo actually shipped. `[預組]` = reachable in a preset deck.


## B2 number (1)

- [  ] `納莉` (SV8a-173, 3 prints) — printed 4/5, absent from handler: 5
  > 從自己的牌庫抽出4張卡。在使用了這張卡的回合結束時，若自己的手牌有5張以上，則將自己的手牌全部丟棄。

## B5 auto-pick (2)

- [  ] `邀請眨眼` (SV9-042, 3 prints) — text says 選擇 but handler opens no prompt
  > 在自己的回合，從手牌使出這張卡並完成進化時，可使用1次。查看對手的手牌，從其中選擇任意數量的【基礎】寶可夢卡，放置於對手的備戰區。
- [  ] `泰姆` (SV-P-093, 2 prints) — text says 選擇 but handler opens no prompt
  > 從自己的手牌選擇1張寶可夢卡，向對手宣言那隻寶可夢的名稱後，翻到反面放置。對手回答那隻寶可夢的HP。將翻到反面的寶可夢卡翻到正面，若正確，則對手從牌庫抽出4張卡。若不正確，則自己從牌庫抽出4張卡。然後，將放置的卡放回自己的手牌。