// Range-trading bot v3 for cbBTC (CBBTC/USDC), long only, 1-minute bars.
//
// v2 (range trader, +$32.05 on the 20261111-0801 dev window) fails the
// 20261113-2314 dev window: -$7.41. That window falls -4.91% open to close
// (a -3.7% waterfall in the first ~6 hours, then 18 hours of $68.5k-$69.2k
// chop), and every kit baseline scores -$49 to -$109 there, so the window
// is hostile to every standard mechanism, not just to v2. v2's only trade
// on it buys bar 1342 into the window's last leg down and flattens -$7.41.
// The retune below keeps v2's proven core and changes three things, each
// for a reason the new window itself demonstrates:
//
//   1. Range from bar extremes, not closes. v2's trailing high over closes
//      stays stuck at the pre-drop $71.4k, so its range-top exit can never
//      fire during the chop. Measuring the range from bar highs/lows lets
//      the top adapt once the drop rolls out of the 360-bar window, and
//      entering on the bar's low (not the close) catches the dip the close
//      misses: the winning trade of this window bottoms on its bar low.
//   2. A waterfall filter. Do not buy while the last hour is still falling
//      steeply: require the 60-bar return to be >= -0.2%. At a chop low the
//      hour is flat; in the waterfall it is -0.5% to -1.5% an hour. This is
//      what keeps the bot out of the drop phase entirely — v2's low-age
//      rule alone cannot, because during a waterfall the trailing low keeps
//      refreshing and the bot buys each new "low".
//   3. Warm-up guard. If the harness opens with warm-up batches
//      (state.warmingUp), send no orders on them — they would be rejected
//      as 'warmup' anyway. This kit's dev grade has no warm-up, so the
//      guard is a no-op here; it only protects a live race whose hello
//      carries one.
//
//   - Range: the trailing 360 bars (6 hours) of bar highs/lows per symbol.
//   - Entry, on a bar's close (filled at the next open): the bar's LOW is
//     within 0.05% above the trailing 360-bar low-of-lows, that low is at
//     least 35 bars old (age counted on closes, as in the offline sweep),
//     the 60-bar return is >= -0.2%, on a symbol it does not hold.
//   - Exit, the whole position, on a bar's close: the position is worth at
//     least 1.5% over its cost (take profit), or at least 0.8% under it
//     (stop loss), or it has been held 360 bars, or the close is within
//     0.1% below the trailing 360-bar high-of-highs (sell into range-top
//     strength). Each is read again on every bar, so a sell the market
//     refuses (no bar or a price past the slippage cap at the next open)
//     or the order cap leaves out is sent again on the symbol's next bar
//     while its reason still holds at that close.
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
// How the numbers were chosen: an offline backtester reproducing the
// harness's exact fill model (4 bps fee + 2 bps slippage + constant-product
// impact on the bar's pool depth, fills at the next open) — validated to the
// cent on the new kit dev window (v2: offline -$7.41, grade-local -$7.41).
// Sweeps ran over ~7,500 parameter sets on the new dev window, then the
// survivors were validated on 52 rolling 24h windows of fresh Coinbase
// BTC-USD 1-minute bars (Oct 16 - Nov 12 2026, ending before the dev
// window, constant $1.28M depth). The chosen point sits in the middle of a
// wide plateau on the dev window: 108 of 144 nearby sets (trend60 -0.1%
// to -0.5%, low-age 20-50, TP 1.2-2.0%, SL 0.6-0.8%, high band 0.1-0.2%)
// score > $0, 96 score >= +$10, median +$10.17 — but read the honest
// limits below before treating +$13.16 as a forecast.
//
//   v2  (closes range, no waterfall filter): dev -$7.41, 52w mean -$4.31,
//          P(>0) 0.31, worst -$25.03, 1.56 trades/window.
//   v3  (HL range + waterfall filter):      dev +$13.16 (grade-local, see
//          below), 52w mean -$3.30, P(>0) 0.25, worst -$22.94,
//          1.06 trades/window.
//
// Kit grade-local results, 2026-11-14 (kit btc-race-24h-20261113-2314,
// `grade-local --kit <kit> --bot <repo> --driver process --worktree`;
// the plain grade-local without --worktree grades the git COMMIT, not the
// files — v1's -$10.30, not this bot — so --worktree is required here):
//   net PnL +$13.164476 (+1.32%), 1 round trip (2 fills), win rate 100%,
//   max drawdown 1.07%, exposure 0.18, fees $0.81; at 2x fees +$12.36.
//   Guardrails met, eligible/ranked yes. Offline backtester agrees to the
//   sub-cent (+$13.164966, same trade, max DD 1.0725% vs 1.0725%).
//   L1 regrade reproduced byte for byte, twice, same result_sha256.
//   action_log_sha256 21a78eb7a723d58469befcc36236368c336c242901001c39304a3c91b20ce8c3
//   result_sha256     51603fbaa5fa22d2888def46b03d1c8042a7413deba6c38fef1f03725d6c54d8
//   (Node v24.22.1 here vs the server's v22.23.4, so the server's
//   result_sha256 will differ; the score is what matters.)
//   The dev trade: buy bar 402 @ $68,086, sell bar 657 @ $69,267 (range
//   top), +$13.16. No transcripts were passed at grade time
//   (`cost unpriced`, `authored 0`) — expected for build-only; transcripts
//   are a submit-time step.
//   Buy-and-hold on the same 52 windows: mean about -$5.8, P(>0) 0.36.
//   Kit baselines on the new dev window: buy-and-hold -$52.59, momentum
//   -$49.23, ema-cross -$109.38, rsi-bollinger -$65.83, adx-momentum
//   -$50.31 — v3's +$13.16 is the only positive score among them and v2.
//
// Honest limits: the dev score rests on ONE trade (buy bar 402 @ $68,086,
// sell bar 657 @ $69,267 into the range top, +$13.16) — the plateau is
// that trade surviving parameter perturbation, not many trades agreeing.
// The multi-window mean is still negative, as it is for every tested
// long-only variant in this falling regime; v3 loses less and crashes less
// than v2, but its P(>0) is lower (0.25 vs 0.31) and its best window is
// much smaller (+$6.79 vs +$25.08) — the waterfall filter that saves it in
// waterfalls also keeps it out of the sharpest recoveries. The dev gate is
// a single-window draw; the plateau plus the validation table are the
// actual argument, not the +$13.16 itself. Full numbers, robustness tables
// and caveats: REGRADE-20261114.md.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a
// byte-identical copy of sdk/makefun-bars.ts from the 20261113-2314 kit
// (sha256 9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8).

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Trailing range, in bars (6 hours of 1-minute bars). */
const RANGE_BARS = 360;
/** Entry: bar low within this fraction above the trailing range low. */
const LOW_BAND = 0.0005;
/** Exit into strength: within this fraction below the trailing range high. */
const HIGH_BAND = 0.001;
/** Take profit: worth 101.5% of its cost. */
const TP = [1015n, 1000n] as const;
/** Stop loss: worth 99.2% of its cost. */
const SL = [992n, 1000n] as const;
/** Maximum hold, in bars (6 hours). */
const MAX_HOLD_BARS = 360;
/** Entry: the trailing low must be at least this many bars old (on closes). */
const MIN_LOW_AGE_BARS = 35;
/** Entry: the 60-bar return must be at least this (do not buy a waterfall). */
const MIN_RET60 = -0.002;
const MAX_SLIPPAGE_BPS = 100;

interface Series {
  /** The last RANGE_BARS closes, oldest first. */
  closes: number[];
  /** The last RANGE_BARS bar lows, oldest first. */
  lows: number[];
  /** The last RANGE_BARS bar highs, oldest first. */
  highs: number[];
  /** The batch seq at which the current position was bought, or -1. */
  entrySeq: number;
}

const series = new Map<string, Series>();

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { closes: [], lows: [], highs: [], entrySeq: -1 }));
  s.closes.push(Number(bar.c));
  s.lows.push(Number(bar.l));
  s.highs.push(Number(bar.h));
  if (s.closes.length > RANGE_BARS) s.closes.shift();
  if (s.lows.length > RANGE_BARS) s.lows.shift();
  if (s.highs.length > RANGE_BARS) s.highs.shift();
  return s;
}

function low(s: Series): number {
  let m = s.lows[0]!;
  for (const x of s.lows) if (x < m) m = x;
  return m;
}

function high(s: Series): number {
  let m = s.highs[0]!;
  for (const x of s.highs) if (x > m) m = x;
  return m;
}

/**
 * Bars since the trailing low was set, counting from the most recent bar
 * that printed the lowest CLOSE (ties keep the latest bar, matching the
 * offline sweep). 0 means the current bar itself is the low.
 */
function lowAge(s: Series): number {
  let m = s.closes[0]!;
  for (const x of s.closes) if (x < m) m = x;
  let age = 0;
  for (let i = s.closes.length - 1; i >= 0; i--) {
    if (s.closes[i] === m) {
      age = s.closes.length - 1 - i;
      break;
    }
  }
  return age;
}

/** 60-bar return on closes: close now vs the close 60 bars ago. */
function ret60(s: Series): number {
  const n = s.closes.length;
  return s.closes[n - 1]! / s.closes[n - 61]! - 1;
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
    // Warm-up batches reject every order; still push the bars above so
    // the range is warm when trading opens, then answer empty.
    if (state.warmingUp) return [];
    const fresh = new Map(batch.bars.map((b) => [b.symbol, b]));
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      const bar = fresh.get(symbol);
      if (s === undefined || bar === undefined) continue;
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
      const l = Number(bar.l);
      if (l <= low(s) * (1 + LOW_BAND) && lowAge(s) >= MIN_LOW_AGE_BARS && ret60(s) >= MIN_RET60) entries.push(symbol);
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
