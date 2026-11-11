// Range-trading bot for cbBTC (CBBTC/USDC), long only, 1-minute bars.
//
// Idea: on a 24h window BTC mostly chops inside a range and drifts. Trend
// followers (EMA cross, ADX) and classic mean reversion (RSI + Bollinger)
// all lose money on the published dev window (-$89, -$59, -$30). What works
// is buying only when the price sits at the very bottom of its own recent
// range and selling into the top of that range, with a hard take-profit and
// stop-loss so a position never rides a trend break for long.
//
//   - Range: the trailing 360 bars (6 hours) of closes per symbol.
//   - Entry, on a bar's close (filled at the next open): the close is within
//     0.05% above the trailing 360-bar low, on a symbol it does not hold.
//     No RSI, no EMA, no confirmation tick: the dip filter alone, plus the
//     range, is the signal. Waiting for an uptick was tested and loses
//     trades; the edge is the range extreme, not the bounce.
//   - Exit, the whole position, on a bar's close: the position is worth at
//     least 1.2% over its cost (take profit), or at least 0.8% under it
//     (stop loss), or it has been held 360 bars, or the close is within
//     0.1% below the trailing 360-bar high (sell into range-top strength).
//     Each is read again on every bar, so a sell the market refuses (no bar
//     or a price past the slippage cap at the next open) or the order cap
//     leaves out is sent again on the symbol's next bar while its reason
//     still holds at that close.
//   - Stake: equity over n slots, n = min(the universe,
//     caps.max_open_positions); each buy the smallest of equity / n,
//     caps.max_weight_bps of equity and the cash this reply has not spent
//     yet; below fees.min_notional_quote_units it buys nothing. It never
//     holds more than n, counting the positions this reply sells (their
//     proceeds land at the next open and fund later buys, never this reply's).
//   - A reply carries the sells first, then the buys in universe order, at
//     most caps.max_orders_per_bar in all. Each order caps its slippage at
//     MAX_SLIPPAGE_BPS = 100, 1% past the close it was decided on, so a sell
//     into a liquidity gap is refused (and sent again) rather than filled
//     for almost nothing; an entry the market refuses is taken again on the
//     next bar that signals it.
//   - Everything runs in float64 on + - * / alone, each correctly rounded
//     (IEEE 754), so the same bars give the same orders, run after run.
//     No clock, no randomness, no network, no files.
//
// How the numbers were chosen: an offline sweep over the published dev
// window (1,440 bars, BTC -1.07% overall) with the harness's exact fill
// model (4 bps fee + 2 bps slippage + constant-product impact on the
// bar's pool depth, fills at the next open). The range family is stable,
// not a single spike: 318 of 432 nearby parameter sets are profitable,
// and every n = 360 (6h) set with band 0.05%-0.1%, TP 1.0%-1.2%,
// SL 0.8%-1.0%, hold 300-360 bars lands between +$15.89 and +$17.87.
// The chosen point (band 0.05%, TP 1.2%, SL 0.8%, hold 360) is the best
// of that n = 360 family at +$17.87 offline, 5 trades, 4 wins, max
// drawdown 1.6%. The 8-hour lookback (n = 480) scores a little higher
// (+$18.24) but on only 2 trades, so it was not taken.
//
// Verified local grade, 2026-11-11 (kit grade-local, --driver process):
//   node cli/makefun.mjs grade-local --kit . --bot <abs path to this dir> --driver process
//   net PnL +$18.13 (+1.81%), 10 trades / 5 round trips, 80% win rate,
//   max drawdown 1.58%, 0 rejected, guardrails met, eligible / ranked yes.
//   L1 regrade reproduces byte for byte (deterministic).
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a
// byte-identical copy of bars/sdk/makefun-bars.ts.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Trailing range, in bars (6 hours of 1-minute bars). */
const RANGE_BARS = 360;
/** Entry: within this fraction above the trailing range low. */
const LOW_BAND = 0.0005;
/** Exit into strength: within this fraction below the trailing range high. */
const HIGH_BAND = 0.001;
/** Take profit: worth 101.2% of its cost. */
const TP = [1012n, 1000n] as const;
/** Stop loss: worth 99.2% of its cost. */
const SL = [992n, 1000n] as const;
/** Maximum hold, in bars (6 hours). */
const MAX_HOLD_BARS = 360;
const MAX_SLIPPAGE_BPS = 100;

interface Series {
  /** The last RANGE_BARS closes, oldest first. */
  closes: number[];
  /** The batch seq at which the current position was bought, or -1. */
  entrySeq: number;
}

const series = new Map<string, Series>();

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { closes: [], entrySeq: -1 }));
  s.closes.push(Number(bar.c));
  if (s.closes.length > RANGE_BARS) s.closes.shift();
  return s;
}

function low(s: Series): number {
  let m = s.closes[0]!;
  for (const x of s.closes) if (x < m) m = x;
  return m;
}

function high(s: Series): number {
  let m = s.closes[0]!;
  for (const x of s.closes) if (x > m) m = x;
  return m;
}

/** Whether a held position exits on this close: TP, SL, max hold, or the range top. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  const value = state.value(symbol, held.qty);
  if (value * TP[1] >= held.cost * TP[0]) return true;
  if (value * SL[1] <= held.cost * SL[0]) return true;
  if (s.entrySeq >= 0 && state.seq - s.entrySeq >= MAX_HOLD_BARS) return true;
  const c = Number(state.latest.get(symbol)!.c);
  if (c >= high(s) * (1 - HIGH_BAND)) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) push(bar);
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined || !fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (s.entrySeq < 0) s.entrySeq = state.seq;
        if (exits(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.entrySeq = -1;
        }
        continue;
      }
      if (s.closes.length < RANGE_BARS) continue;
      const c = Number(state.latest.get(symbol)!.c);
      if (c <= low(s) * (1 + LOW_BAND)) entries.push(symbol);
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      series.get(symbol)!.entrySeq = state.seq;
      cash -= slice;
      room--;
    }
    return orders;
  },
});
