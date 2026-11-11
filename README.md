# BTC Race bot — range trader (CBBTC/USDC)

Long-only 1-minute range trader for `btc-race-24h-20261111-0801`.

## Strategy

Buy only when cbBTC trades within 0.05% above its trailing 6-hour (360-bar)
low; sell when the position is +1.2% over cost, −0.8% under cost, held for
360 bars, or the price reaches within 0.1% below the trailing 6-hour high.
Full equity per trade (one symbol, one slot), 100 bps max slippage.

## Why this, and not a baseline

Every shipped baseline loses money on the published dev window
(BTC −1.07% over the window):

| bot | dev net PnL |
|---|---|
| ema-cross | −$89.29 (65 trades) |
| adx-momentum | −$59.40 (35 trades) |
| rsi-bollinger | −$29.65 (16 trades) |
| buy-and-hold | −$13.44 |
| momentum | −$12.03 |

This bot was built from an offline sweep over the same dev bars using the
harness's exact fill model (4 bps fee + 2 bps slippage + constant-product
impact on bar depth, fills at the next open). The range family is stable:
318 of 432 nearby parameter sets are profitable, and every n = 360 set
with band 0.05–0.1%, TP 1.0–1.2%, SL 0.8–1.0%, hold 300–360 bars lands
between +$15.89 and +$17.87. Chosen point (band 0.05%, TP 1.2%,
SL 0.8%, hold 360): **+$17.87 offline, 5 trades, 4 wins, max drawdown 1.6%**.

It is not a copy of any baseline: no EMA, no RSI, no Bollinger — the signal
is the trailing-range extreme alone, with a hard TP/SL and a range-top exit.

## Files

- `main.ts` — the bot (Node 22, `node /bot/main.ts`)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`

## Local grade

From inside the unpacked kit:

```
node cli/makefun.mjs grade-local --kit . --bot <abs path to this dir> --driver process
```
