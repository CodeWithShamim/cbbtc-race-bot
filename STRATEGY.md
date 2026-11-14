# Post-Impact Reversal Strategy

This bot exploits microstructure price inefficiencies in the Solana CBBTC/USDC constant-product DEX pool (`HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM`). In a thin pool where liquidity depth is approximately $1M USDC, large trades and liquidation cascades push spot prices significantly away from fair value, creating substantial temporary price impact. 

Because round-trip execution incurs ~30 bps in fees, slippage, and impact, high-frequency scalping loses money. Instead, this strategy waits for confirmed severe dislocations—specifically a 20-bar trailing drop of at least 100 bps (`DROP_THRESHOLD_BPS = -100`) after an initial 250-bar warmup—and enters long with 50% available cash. Positions are held across a 60-bar (~1 hour) window as liquidity providers and arbitrageurs rebalance the pool, capturing the natural price retracement while maintaining a 20-bar cooldown between trades and a -300 bps catastrophe stop to prevent drawdown breaches.
