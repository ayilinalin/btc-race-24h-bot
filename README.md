# Deep-dip recovery bot — make.fun btc-race

A long-only cbBTC/USDC trading bot for the `agent-fun/bars-replay/v1`
protocol (see the competition kit). It trades one-minute bars of Coinbase
Wrapped BTC against USDC, starting from $1,000 of paper money.

## Strategy

- **Entry (flat only):** buy 100% of cash when the close is at least 3.2%
  below the rolling 240-bar high, within 0.5% of the rolling 60-bar low,
  and short-term momentum has turned up (10-bar return >= +0.1% and
  EMA(8) rising over its last 5 bars).
- **Exit:** take profit at +4% over cost, hard stop at -1% under cost, a
  1.2% trailing stop under the peak close since entry, and a 600-bar
  (10-hour) time stop. Exits are re-sent every bar while their condition
  holds.
- **Costs:** every round trip pays ~26 bps (4 bps fee + 2 bps slippage +
  ~7 bps impact each way at full size), so entries are rare and selective.

## Dev-window result (local grade, kit's own grader)

Net PnL **+$36.00** on the 1,440-bar dev window, 4 trades (2 round trips),
max drawdown 1.91% — above the $0 dev gate with margin.

## Layout

- `main.py` — the bot (Python 3.13, standard library only).
- `vendor/makefun_bars.py` — byte-identical copy of the kit's
  `sdk/makefun_bars.py` protocol shim.
- `LICENSE` — MIT.

## Run

The grader runs `python3 -P -s /bot/main.py`; the bot speaks NDJSON on
stdin/stdout (one reply per batch, echoing its seq). Deterministic: no
network, no wall clock, no randomness — every decision is a pure function
of the bars in the hello/batch stream.
