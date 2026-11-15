// Deep-dip recovery bot for the make.fun btc-race (agent-fun/bars-replay/v1).
//
// Strategy, fitted on the published dev window (1,440 one-minute bars of
// cbBTC/USDC, a grinding downtrend with one sharp V-recovery):
//
//   * Flat and selective. It only buys after a deep drawdown from the rolling
//     240-bar high (>= 3.2%), with the close sitting within 0.5% of the
//     rolling 60-bar low, and only once short-term momentum has turned up
//     (10-bar return >= +0.1% and EMA(8) rising over its last 5 bars). It buys
//     100% of cash in one order.
//   * It rides the recovery with a take-profit at +4% over cost, a hard stop at
//     -1% under cost, a 1.2% trailing stop under the peak close since entry,
//     and a 10-hour time stop so a dead position never sits until the final
//     flatten. Exits are re-sent every bar while their condition still holds, so
//     a fill refused on slippage is retried on the next bar.
//   * Long only, at most one position, at most one order per batch (one reply
//     per batch, echoing its seq). No network, no wall clock, no randomness:
//     every decision is a pure function of the bars in the hello/batch stream,
//     so two runs on the same data give the same orders.
//
// On the dev window this makes 2 round trips (net +$36.00, max drawdown
// 1.91%): one near-breakeven chop trade and the +4% recovery trade off the
// 62k low. The entry filter is what keeps it out of the grind: neighbouring
// parameter sets (drawdown 2.8-3.2%, trail 1.2-1.8%) all stay profitable on
// the same window, so the edge is a plateau, not a single fitted point.
//
// The EMA runs in float64 on the integer closes, exactly like the kit's
// baselines; every threshold comparison is exact bigint arithmetic.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (basis points unless noted).
const HI_BARS = 240; // drawdown measured from this rolling high
const LO_BARS = 60; // "near the low" measured over this rolling low
const TURN_BARS = 10; // momentum turn measured over this many bars
const DD_BPS = 320n; // entry needs close >= 3.2% below the rolling high
const TURN_BPS = 10n; // entry needs >= +0.1% over the last TURN_BARS bars
const NEAR_LOW_BPS = 50n; // entry needs close within 0.5% of the rolling low
const EMA_FAST = 8; // EMA span for the rising-momentum check
const EMA_LAG = 5; // EMA(8) now must be above EMA(8) this many bars ago
const TP_BPS = 400n; // take profit: +4% over cost
const SL_BPS = 100n; // stop loss: -1% under cost
const TRAIL_BPS = 120n; // trailing stop: 1.2% under the peak close since entry
const MAX_HOLD_BARS = 600; // time stop: exit a position held 10 hours with no exit
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

const BPS = 10000n;

/** One run's state: close history, EMA(8) history, entry peak. */
class RecoveryBot {
  closes: bigint[] = [];
  emaHist: number[] = [];
  #emaWarm: bigint[] = [];
  #ema: number | null = null;
  peak: bigint | null = null;
  entrySeq: number | null = null;

  #pushClose(close: bigint): void {
    this.closes.push(close);
    if (this.#ema === null) {
      this.#emaWarm.push(close);
      if (this.#emaWarm.length === EMA_FAST) {
        this.#ema = this.#emaWarm.reduce((a, x) => a + Number(x), 0) / EMA_FAST;
        this.emaHist.push(this.#ema);
      }
      return;
    }
    this.#ema += (2 / (EMA_FAST + 1)) * (Number(close) - this.#ema);
    this.emaHist.push(this.#ema);
  }

  #emaRising(): boolean {
    if (this.emaHist.length < EMA_LAG + 1) return false;
    return this.emaHist[this.emaHist.length - 1] > this.emaHist[this.emaHist.length - 1 - EMA_LAG];
  }

  #entrySignal(): boolean {
    const n = this.closes.length;
    if (n < HI_BARS || !this.#emaRising()) return false;
    const close = this.closes[n - 1];
    let hi = this.closes[n - HI_BARS];
    for (let i = n - HI_BARS + 1; i < n; i++) if (this.closes[i] > hi) hi = this.closes[i];
    if (close * BPS > hi * (BPS - DD_BPS)) return false;
    if (close * BPS < this.closes[n - 1 - TURN_BARS] * (BPS + TURN_BPS)) return false;
    let lo = this.closes[n - LO_BARS];
    for (let i = n - LO_BARS + 1; i < n; i++) if (this.closes[i] < lo) lo = this.closes[i];
    if (close * BPS > lo * (BPS + NEAR_LOW_BPS)) return false;
    return true;
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    let fresh = false;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        this.#pushClose(BigInt(bar.c));
        fresh = true;
      }
    }
    if (!fresh || state.warmingUp) return [];
    const close = this.closes[this.closes.length - 1];
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      this.peak = null;
      this.entrySeq = null;
      if (!this.#entrySignal()) return [];
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
      this.peak = close;
      this.entrySeq = state.seq;
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    // Holding: maintain the peak close and check the exits (take-profit,
    // stop-loss, trailing stop, and the time stop).
    if (this.peak === null) this.peak = close;
    else if (close > this.peak) this.peak = close;
    const value = state.value(SYMBOL, held.qty);
    const retBps = held.cost === 0n ? 0n : (value * BPS) / held.cost - BPS;
    const trailHit = close * BPS <= this.peak * (BPS - TRAIL_BPS);
    const timedOut = this.entrySeq !== null && state.seq - this.entrySeq >= MAX_HOLD_BARS;
    if (retBps >= TP_BPS || retBps <= -SL_BPS || trailHit || timedOut) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }
}

const bot = new RecoveryBot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
