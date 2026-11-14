import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';

const BPS = 10_000n;
const INITIAL_CASH = 1_000_000_000n; // 1,000 USDC in micro-USDC
const PRICE_SCALE = 5;
const QTY_SCALE = 8;
const QUOTE_SCALE = 6;
const FEE_BPS = 4n;
const SLIPPAGE_BPS = 2n;

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export class BarsPool {
  constructor(yn, yd, kn, kd, unit) {
    const g = gcd(yn, yd);
    this.yn = yn / g;
    this.yd = yd / g;
    this.kn = kn;
    this.kd = kd;
    this.unit = unit;
  }

  static of(depth, quoteScale = 6) {
    const d = depth.map((x) => x * 10n ** BigInt(quoteScale));
    const prod = d.reduce((p, x) => p * x, 1n);
    const sum = d.map((_, i) => d.reduce((p, x, j) => (j === i ? p : p * x), 1n)).reduce((s, x) => s + x, 0n);
    const g = gcd(prod, sum);
    return new BarsPool(prod / g, sum / g, (prod / g) ** 2n, (sum / g) ** 2n, 10n ** 6n);
  }

  buy(spend) {
    const yn2 = this.yn + spend * this.unit * this.yd;
    return { num: this.yn * yn2 * this.kd, den: this.yd * this.yd * this.kn, after: new BarsPool(yn2, this.yd, this.kn, this.kd, this.unit) };
  }

  sell(value) {
    const t = this.kn * this.yd + value * this.unit * this.yn * this.kd;
    return { num: t * this.yd, den: this.kd * this.yn * this.yn, after: new BarsPool(this.kn * this.yn, t, this.kn, this.kd, this.unit) };
  }
}

export function barsValue(qty, price) {
  return (qty * price * 10n ** BigInt(QUOTE_SCALE)) / 10n ** BigInt(QTY_SCALE + PRICE_SCALE);
}

export function buyFill(notional, open, depth) {
  const bps = { fee_bps: FEE_BPS, slippage_bps: SLIPPAGE_BPS };
  const spend = (notional * (BPS - bps.fee_bps)) / BPS;
  const m = BarsPool.of(depth, QUOTE_SCALE).buy(spend);
  const price = (open * (BPS + bps.slippage_bps) * m.num) / (BPS * m.den);
  const qty = (spend * 10n ** BigInt(QTY_SCALE + PRICE_SCALE)) / (price * 10n ** BigInt(QUOTE_SCALE));
  return { price, spend, fee: notional - spend, qty };
}

export function sellFill(qty, priceRef, depth) {
  const bps = { fee_bps: FEE_BPS, slippage_bps: SLIPPAGE_BPS };
  const m = BarsPool.of(depth, QUOTE_SCALE).sell(barsValue(qty, priceRef));
  const slipped = (priceRef * (BPS - bps.slippage_bps) * m.den) / (BPS * m.num);
  const price = slipped < 1n ? 1n : slipped;
  const gross = barsValue(qty, price);
  const proceeds = (gross * (BPS - bps.fee_bps)) / BPS;
  return { price, gross, fee: gross - proceeds, proceeds };
}

export async function loadBars(filePath) {
  const fileStream = fs.createReadStream(filePath);
  const unzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: fileStream.pipe(unzip), crlfDelay: Infinity });
  const bars = [];
  for await (const line of rl) {
    if (line.trim()) {
      const b = JSON.parse(line);
      bars.push({
        t: b.t,
        o: BigInt(b.o),
        h: BigInt(b.h),
        l: BigInt(b.l),
        c: BigInt(b.c),
        o_depth: b.o_depth.map((d) => BigInt(d)),
        c_depth: b.c_depth.map((d) => BigInt(d)),
      });
    }
  }
  return bars;
}

export function evaluateStrategy(bars, config = {}) {
  const {
    dropWindow = 20,
    threshBps = -100,
    holdBars = 60,
    maxHoldBars = 240,
    catastropheStopBps = -300,
    cooldownBars = 20,
    warmupBars = 250,
    sizePct = 50,
  } = config;

  let cash = INITIAL_CASH;
  let posQty = 0n;
  let pending = null;
  let entryPrice = 0n;
  let entrySeq = -1;
  let lastExit = -9999;
  let trades = 0;
  let wins = 0;

  const closes = [];
  const eqSeries = [];
  const blockEq = [cash];

  for (let seq = 0; seq < bars.length; seq++) {
    const b = bars[seq];

    if (pending !== null) {
      if (pending.side === 'buy') {
        const fill = buyFill(pending.notional, b.o, b.o_depth);
        cash -= (fill.spend + fill.fee);
        posQty += fill.qty;
        entryPrice = fill.price;
        entrySeq = seq;
      } else if (pending.side === 'sell') {
        const fill = sellFill(pending.qty, b.o, b.o_depth);
        cash += fill.proceeds;
        posQty = 0n;
        lastExit = seq;
        trades++;
        if (fill.proceeds > pending.cost) wins++;
      }
      pending = null;
    }

    closes.push(b.c);
    const curEq = cash + (posQty > 0n ? barsValue(posQty, b.c) : 0n);
    eqSeries.push(curEq);
    if (seq === 359 || seq === 719 || seq === 1079) blockEq.push(curEq);

    if (seq === bars.length - 1) {
      if (posQty > 0n) {
        const fill = sellFill(posQty, b.c, b.c_depth);
        cash += fill.proceeds;
        posQty = 0n;
        trades++;
        if (fill.proceeds > (INITIAL_CASH * BigInt(sizePct)) / 100n) wins++;
      }
      blockEq.push(cash);
      break;
    }

    if (posQty > 0n) {
      const heldBars = seq - entrySeq;
      const gainBps = Number(((b.c - entryPrice) * BPS) / entryPrice);
      const shouldExit =
        heldBars >= holdBars ||
        gainBps <= catastropheStopBps ||
        heldBars >= maxHoldBars;

      if (shouldExit) {
        pending = { side: 'sell', qty: posQty, cost: (INITIAL_CASH * BigInt(sizePct)) / 100n };
      }
    } else {
      if (closes.length < warmupBars || closes.length <= dropWindow) continue;
      if (seq - lastExit < cooldownBars) continue;

      const cNow = closes[closes.length - 1];
      const cPast = closes[closes.length - 1 - dropWindow];
      const retBps = Number(((cNow - cPast) * BPS) / cPast);

      if (retBps <= threshBps) {
        const notional = (cash * BigInt(sizePct)) / 100n;
        if (notional >= 1_000_000n && notional <= cash) {
          pending = { side: 'buy', notional };
        }
      }
    }
  }

  const netPnlMicro = cash - INITIAL_CASH;
  const netPnlUsdc = Number(netPnlMicro) / 1e6;

  let peak = INITIAL_CASH;
  let maxDd = 0;
  for (const eq of eqSeries) {
    if (eq > peak) peak = eq;
    const dd = Number(peak - eq) / Number(peak);
    if (dd > maxDd) maxDd = dd;
  }

  const blockPnlUsdc = [
    Number(blockEq[1] - blockEq[0]) / 1e6,
    Number(blockEq[2] - blockEq[1]) / 1e6,
    Number(blockEq[3] - blockEq[2]) / 1e6,
    Number(blockEq[4] - blockEq[3]) / 1e6,
  ];

  return {
    netPnlUsdc,
    trades,
    wins,
    winRate: trades > 0 ? wins / trades : 0,
    maxDd,
    blockPnlUsdc,
  };
}

async function main() {
  const kitPath = path.resolve('../btc-race-24h-20261113-2314-kit');
  const barsPath = path.join(kitPath, 'dataset/bars/CBBTC.ndjson.gz');
  if (!fs.existsSync(barsPath)) {
    console.error('Dataset not found at', barsPath);
    return;
  }

  const bars = await loadBars(barsPath);
  console.log(`Loaded ${bars.length} bars from ${barsPath}`);

  // Base production config
  const prodConfig = {
    dropWindow: 20,
    threshBps: -100,
    holdBars: 60,
    maxHoldBars: 240,
    catastropheStopBps: -300,
    cooldownBars: 20,
    warmupBars: 250,
    sizePct: 50,
  };

  const prodRes = evaluateStrategy(bars, prodConfig);
  console.log('\n=== Production Config Evaluation ===');
  console.log(`Net PnL: ${prodRes.netPnlUsdc.toFixed(6)} USDC`);
  console.log(`Round-trip trades: ${prodRes.trades} (Win rate: ${(prodRes.winRate * 100).toFixed(1)}%)`);
  console.log(`Max Drawdown: ${(prodRes.maxDd * 100).toFixed(3)}%`);
  console.log(
    `Walk-forward blocks (6h each): [${prodRes.blockPnlUsdc.map((b) => b.toFixed(2)).join(', ')}] USDC`
  );

  console.log('\n=== Parameter Plateau Sensitivity Grid ===');
  console.log('DropWin | Thresh | Hold | Size | Net PnL (USDC) | Trades | Max DD | Blocks');
  console.log('-------------------------------------------------------------------------');
  for (const dropWindow of [15, 20, 25]) {
    for (const threshBps of [-90, -100, -110]) {
      for (const holdBars of [50, 60, 70]) {
        const res = evaluateStrategy(bars, { ...prodConfig, dropWindow, threshBps, holdBars });
        console.log(
          `${dropWindow.toString().padStart(7)} | ${threshBps.toString().padStart(6)} | ${holdBars.toString().padStart(4)} | ${prodConfig.sizePct}%  | ${res.netPnlUsdc.toFixed(2).padStart(14)} | ${res.trades.toString().padStart(6)} | ${(res.maxDd * 100).toFixed(2).padStart(5)}% | [${res.blockPnlUsdc.map((b) => b.toFixed(2)).join(', ')}]`
        );
      }
    }
  }
}

if (process.argv[1]?.endsWith('sweep.mjs')) {
  main();
}
