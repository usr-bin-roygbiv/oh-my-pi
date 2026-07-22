# Native diff benchmark

- Source: `5f41203f0` (clean), release/ci-profile native build, `PI_COMPILED=1`
- Runtime: bun 1.3.14, darwin-arm64 (Apple M4 Pro)
- Method: seeded synthetic docs, per-scenario warmup + timed iterations, crossing-inclusive (measures the full N-API boundary)
- Command: `PI_COMPILED=1 bun packages/natives/bench/diff.ts` (`BENCH_WARMUP`/`BENCH_ITERATIONS` env overrides)

## Results (warmup 2, iterations 10/scenario)

| scenario | jsdiff diffLines | native diffLines | speedup | jsdiff structuredPatch | native hunks | speedup |
|---|---|---|---|---|---|---|
| 100 lines / 1% edits | 91.9µs | 16.3µs | 5.6x | 65.0µs | 21.8µs | 3.0x |
| 100 lines / 20% edits | 120.1µs | 26.9µs | 4.5x | 96.3µs | 30.3µs | 3.2x |
| 5000 lines / 1% edits | 1.16ms | 514.4µs | 2.3x | 1.48ms | 464.4µs | 3.2x |
| 5000 lines / 20% edits | 134.47ms | 21.49ms | 6.3x | 125.73ms | 21.23ms | 5.9x |
| 50000 lines / 1% edits | 38.94ms | 9.84ms | 4.0x | 41.51ms | 9.92ms | 4.2x |
| 50000 lines / 20% edits | 22790.94ms | 2350.67ms | 9.7x | 23480.65ms | 2395.80ms | 9.8x |

A higher-iteration run (warmup 5, iterations 50) over the first five scenarios reproduced the same band (1.9x–6.5x); the 50k/20% row uses 10 iterations because jsdiff needs ~23s per iteration there.

## Notes

- Native wins at every measured size; no crossover where the N-API crossing cost dominates (smallest input, 100 lines, is still 3–5.6x).
- The worst jsdiff case (50k lines / 20% edit density) is a 23s synchronous stall on the render path vs 2.4s native.
- Parity: `packages/natives/test/diff-parity.test.ts` (jsdiff vs native, structural equality; 207 expects) plus existing `edit-diff.test.ts` (42 expects) pass unchanged.
