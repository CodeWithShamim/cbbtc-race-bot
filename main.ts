/**
 * Post-Impact Reversal Trading Bot for CBBTC/USDC on Solana.
 *
 * Strategy:
 * When large market orders impact the thin liquidity pool, the price is pushed
 * significantly below equilibrium. This bot waits for a sharp multi-bar drop
 * (20-bar return <= -100 bps) and enters long with 50% cash to capture the
 * subsequent mean-reversion bounce over a 60-bar holding horizon.
 */

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

/** Symbol to trade in the replay. */
const SYMBOL = 'CBBTC';

/** Number of bars required for history warm-up before considering entries. */
const WARMUP_HISTORY_BARS = 250;

/** Lookback window in bars to measure the multi-bar post-impact drop. */
const DROP_WINDOW_BARS = 20;

/** Return threshold in basis points (<= -100 bps, or -1.00%) that triggers an entry. */
const DROP_THRESHOLD_BPS = -100n;

/** Target holding duration in bars (minutes) after which the position is closed. */
const HOLD_BARS = 60;

/** Maximum bars allowed to hold a position as an absolute safety timeout. */
const MAX_HOLD_BARS = 240;

/** Catastrophe stop loss in basis points (-300 bps = -3.00%) to protect against drawdowns. */
const CATASTROPHE_STOP_BPS = -300n;

/** Cooldown period in bars after an exit before considering new entries. */
const COOLDOWN_BARS = 20;

/** Sizing fraction: allocate 50% of available cash on entry. */
const SIZE_PERCENT = 50n;

/** Maximum slippage bound in basis points (200 bps = 2.00%) per competition specification. */
const MAX_SLIPPAGE_BPS = 200;

/** Minimum notional quote units required by the protocol (1 USDC = 1,000,000 micro-USDC). */
const MIN_NOTIONAL_MICRO_USDC = 1_000_000n;

/** Basis points divisor (10,000 bps = 100%). */
const BPS = 10_000n;

/** Rolling history of closes for CBBTC. */
const closes: bigint[] = [];

/** Sequence number of the batch where the current position entered. */
let entrySeq = -1;

/** Fill price of the current open position. */
let entryPrice: bigint | null = null;

/** Sequence number of the most recent exit fill to enforce cooldown. */
let lastExitSeq = -9999;

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1. Process fills reported in this batch to update entry/exit state
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.status === 'filled') {
        if (fill.side === 'buy') {
          entrySeq = batch.seq;
          entryPrice = BigInt(fill.price);
        } else if (fill.side === 'sell') {
          lastExitSeq = batch.seq;
          entrySeq = -1;
          entryPrice = null;
        }
      }
    }

    // 2. Record the latest close
    const latestClose = state.close(SYMBOL);
    if (latestClose !== null) {
      closes.push(latestClose);
    }

    // 3. Check held position management
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      const heldBars = entrySeq >= 0 ? batch.seq - entrySeq : 0;
      const refPrice = entryPrice ?? latestClose;

      let gainBps = 0n;
      if (refPrice !== null && refPrice > 0n && latestClose !== null) {
        gainBps = ((latestClose - refPrice) * BPS) / refPrice;
      }

      // Exit on target holding duration, catastrophe stop, or max hold timeout
      const shouldExit =
        heldBars >= HOLD_BARS ||
        gainBps <= CATASTROPHE_STOP_BPS ||
        heldBars >= MAX_HOLD_BARS;

      if (shouldExit) {
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }

      return [];
    }

    // 4. Entry logic (only when flat)
    if (closes.length < WARMUP_HISTORY_BARS || closes.length <= DROP_WINDOW_BARS) {
      return [];
    }

    // Enforce cooldown after previous exit
    if (batch.seq - lastExitSeq < COOLDOWN_BARS) {
      return [];
    }

    // Calculate trailing drop return over DROP_WINDOW_BARS
    const cNow = closes[closes.length - 1]!;
    const cPast = closes[closes.length - 1 - DROP_WINDOW_BARS]!;
    if (cPast <= 0n) {
      return [];
    }

    const retBps = ((cNow - cPast) * BPS) / cPast;

    // Trigger entry when sharp drop reaches threshold
    if (retBps <= DROP_THRESHOLD_BPS) {
      const halfCash = (state.cash * SIZE_PERCENT) / 100n;
      const room = state.weightRoom(SYMBOL);
      const notional = halfCash < room ? halfCash : room;

      if (notional >= MIN_NOTIONAL_MICRO_USDC && notional <= state.cash) {
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }

    return [];
  },
});
