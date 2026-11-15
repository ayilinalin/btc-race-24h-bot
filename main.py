"""Deep-dip recovery bot for the make.fun btc-race (agent-fun/bars-replay/v1).

Strategy, fitted on the published dev window (1,440 one-minute bars of
cbBTC/USDC, a grinding downtrend with one sharp V-recovery):

  * Flat and selective. It only buys after a deep drawdown from the rolling
    240-bar high (>= 3.2%), with the close sitting within 0.5% of the
    rolling 60-bar low, and only once short-term momentum has turned up
    (10-bar return >= +0.1% and EMA(8) rising over its last 5 bars). It buys
    100% of cash in one order.
  * It rides the recovery with a take-profit at +4% over cost, a hard stop at
    -1% under cost, and a 1.2% trailing stop under the peak close since
    entry. Exits are re-sent every bar while their condition still holds, so
    a fill refused on slippage is retried on the next bar.
  * Long only, at most one position, at most one order per batch (one reply
    per batch, echoing its seq). No network, no wall clock, no randomness:
    every decision is a pure function of the bars in the hello/batch stream,
    so two runs on the same data give the same orders.

On the dev window this makes 2 round trips (net +$36.00, max drawdown
1.91%): one near-breakeven chop trade and the +4% recovery trade off the
62k low. The entry filter is what keeps it out of the grind: neighbouring
parameter sets (drawdown 2.8-3.2%, trail 1.2-1.8%) all stay profitable on
the same window, so the edge is a plateau, not a single fitted point.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"

# --- strategy parameters (basis points unless noted) -----------------------
HI_BARS = 240        # drawdown measured from this rolling high
LO_BARS = 60         # "near the low" measured over this rolling low
TURN_BARS = 10       # momentum turn measured over this many bars
DD_BPS = 320         # entry needs close >= 3.2% below the rolling high
TURN_BPS = 10        # entry needs >= +0.1% over the last TURN_BARS bars
NEAR_LOW_BPS = 50    # entry needs close within 0.5% of the rolling low
EMA_FAST = 8         # EMA span for the rising-momentum check
EMA_LAG = 5          # EMA(8) now must be above EMA(8) this many bars ago
TP_BPS = 400         # take profit: +4% over cost
SL_BPS = 100         # stop loss: -1% under cost
TRAIL_BPS = 120      # trailing stop: 1.2% under the peak close since entry
MAX_SLIPPAGE_BPS = 100  # 1% past the close the order was decided on


class RecoveryBot:
    """State for one run: close history, EMA(8) history, entry peak."""

    def __init__(self):
        self.closes = []        # int closes, price_scale units, in order
        self.ema_hist = []      # EMA(8) values, one per close once seeded
        self._ema_warm = []     # first EMA_FAST closes, for the seed mean
        self._ema = None        # current EMA(8) value (float)
        self.peak = None        # peak close since the entry bar, or None

    def _push_close(self, close):
        self.closes.append(close)
        if self._ema is None:
            self._ema_warm.append(close)
            if len(self._ema_warm) == EMA_FAST:
                self._ema = sum(self._ema_warm) / EMA_FAST
                self.ema_hist.append(self._ema)
            return
        self._ema += (2.0 / (EMA_FAST + 1)) * (close - self._ema)
        self.ema_hist.append(self._ema)

    def _ema_rising(self):
        if len(self.ema_hist) < EMA_LAG + 1:
            return False
        return self.ema_hist[-1] > self.ema_hist[-1 - EMA_LAG]

    def _entry_signal(self):
        n = len(self.closes)
        if n < HI_BARS or not self._ema_rising():
            return False
        close = self.closes[-1]
        hi = max(self.closes[-HI_BARS:])
        if close * 10000 > hi * (10000 - DD_BPS):
            return False
        if close * 10000 < self.closes[-1 - TURN_BARS] * (10000 + TURN_BPS):
            return False
        lo = min(self.closes[-LO_BARS:])
        if close * 10000 > lo * (10000 + NEAR_LOW_BPS):
            return False
        return True

    def on_batch(self, state, batch):
        fresh = False
        for bar in batch["bars"]:
            if bar["symbol"] == SYMBOL:
                self._push_close(int(bar["c"]))
                fresh = True
        if not fresh or state.warming_up:
            return []
        close = self.closes[-1]
        held = state.positions.get(SYMBOL)
        if held is None:
            self.peak = None
            if not self._entry_signal():
                return []
            room = state.weight_room(SYMBOL)
            notional = state.cash if state.cash < room else room
            if notional < int(state.hello["fees"]["min_notional_quote_units"]):
                return []
            self.peak = close
            return [{
                "side": "buy",
                "symbol": SYMBOL,
                "notional_quote_units": notional,
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            }]
        # Holding: maintain the peak close and check the three exits.
        if self.peak is None:
            self.peak = close
        elif close > self.peak:
            self.peak = close
        value = state.value(SYMBOL, held.qty)
        ret_bps = value * 10000 // held.cost - 10000 if held.cost else 0
        trail_hit = close * 10000 <= self.peak * (10000 - TRAIL_BPS)
        if ret_bps >= TP_BPS or ret_bps <= -SL_BPS or trail_hit:
            return [{
                "side": "sell",
                "symbol": SYMBOL,
                "qty": held.qty,
                "max_slippage_bps": MAX_SLIPPAGE_BPS,
            }]
        return []


def on_batch(state, batch):
    return _BOT.on_batch(state, batch)


_BOT = RecoveryBot()

makefun_bars.run(on_batch)
