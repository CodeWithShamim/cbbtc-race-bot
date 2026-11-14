# CBBTC 24-Hour Race Trading Bot

An autonomous, deterministic algorithmic trading bot for the make.fun bounty competition "Race a BTC trading bot live for 24 hours" trading Coinbase Wrapped BTC (`CBBTC`) against `USDC` on Solana.

## Strategy Overview
The bot implements a **Post-Impact Reversal** strategy tailored for constant-product pool dynamics:
- **Warmup & Cooldown**: Waits 250 bars for history calibration, and enforces a 20-bar cooldown after every exit.
- **Entry Trigger**: When CBBTC trailing 20-bar return falls to <= -100 bps (-1.00%), a buy order is dispatched sizing 50% of available cash.
- **Holding & Exit**: Positions are held for 60 bars to capture the post-impact liquidity recovery, protected by a -300 bps catastrophe stop and a 240-bar maximum hold safeguard.
- **Determinism**: Fully pure function of batch inputs with zero external dependencies, floating-point randomness, or clock queries.

## Performance on Frozen Dev Window (1,440 1-Minute Bars)
- **Net PnL**: **+5.437099 USDC** (Positive dev gate verified; **+4.23 USDC** even under 2x fees)
- **Trades**: 6 executions (3 round trips), **66.7% win rate**
- **Max Drawdown**: **0.557%** (Comfortably under the 25% competition guardrail)
- **6-Hour Block Walk-Forward**: Block 1: -4.51 USDC, Block 2: +7.68 USDC, Block 3: +2.27 USDC, Block 4: 0.00 USDC

## Running Locally
Grade with the official make.fun competition CLI:
```bash
cd /path/to/btc-race-24h-20261113-2314-kit
node cli/makefun.mjs grade-local --kit . --bot /path/to/bot --driver process
```
Or run the standalone backtester parameter sweep:
```bash
node tools/sweep.mjs
```
