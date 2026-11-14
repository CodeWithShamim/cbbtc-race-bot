import { runBars } from './vendor/makefun-bars.ts';

await runBars({
  onBatch() {
    return [];
  },
});
