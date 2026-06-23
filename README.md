# Perpetual Preferred Against Bitcoin Backtest

Replication artifact for the paper **"Perpetual Preferred Equity Against Bitcoin: A stripped-model backtest of the starting Bitcoin Coverage Ratios that clear observed Bitcoin drawdowns"** (Jackson Fairbanks, 2026).

Repository: https://github.com/jacksonfairbanks/perpetual-preferred-against-bitcoin-backtest
License: MIT (see `LICENSE`)

## What this is

The paper measures the Bitcoin Coverage Ratio (BCR = BTC reserve value / annual dividend obligation) at which a stripped-model perpetual preferred issuer clears observed Bitcoin drawdowns. It applies the stripped model to four real BTC drawdown regimes (April 2013, Mt. Gox 2014, ICO Unwind 2018, Fed Tightening 2022) plus a 2011 supplementary regime, sweeps 245 starting-BCR values per regime, and records the required starting BCR for primary failure (BCR<1x) and for terminal liquidity at 0.1x resolution.

This repository bundles everything needed to reproduce the paper's data export: the canonical solvency engine, the export pipeline, the two raw price sources, and the published output CSVs.

## Quickstart

```
git clone https://github.com/jacksonfairbanks/perpetual-preferred-against-bitcoin-backtest.git
cd perpetual-preferred-against-bitcoin-backtest
./verify.sh                                # check bundled file hashes
```

Four-step canonical chain (monthly main results):

```
node scripts/preprocess-bitstamp.js
node scripts/export.js
node scripts/build-surface.js
node scripts/build-surface-grid-validation.js
```

Daily-cadence sensitivity (paper §5.1 footnote 1) only needs the first two:

```
node scripts/preprocess-bitstamp.js
node scripts/export.js --cadence=daily
```

There is no daily surface; do not run `build-surface.js --cadence=daily` (the flag has no effect there: the surface is constructed at monthly cadence only, per paper §6.6).

`bcr_3d_viewer.html` is a self-contained interactive view of the §6.6 coverage surface (Plotly via CDN). Open it in any modern browser; no server needed. The viewer's embedded data is a snapshot of `outputs/surface_grid.csv` and is regenerable byte-for-byte via `node scripts/bake-viewer.js`. After re-running `build-surface.js`, re-bake the viewer and refresh its hash in `verify.sh`.

Node 20+. Zero runtime dependencies. Windows: run `verify.sh` under Git Bash or WSL; or use `Get-FileHash` against the values in `verify.sh`.

## Repository layout

```
perpetual-preferred-against-bitcoin-backtest/
├── README.md                                this file
├── LICENSE                                  MIT
├── REPRODUCE.md                             step-by-step replication
├── verify.sh                                hash verification script
├── bcr_3d_viewer.html                       interactive 3D coverage surface (Plotly, snapshot of outputs/surface_grid.csv; paper §6.6)
├── src/
│   └── solvency-engine.js                   canonical BCR backtest engine
├── scripts/
│   ├── README.md                            script catalog (canonical chain + figure-data scripts)
│   ├── preprocess-bitstamp.js               canonical step 1: LOCF imputation for the raw Bitstamp series
│   ├── export.js                            canonical step 2: sweep runner; emits all output CSVs
│   ├── build-surface.js                     canonical step 3: pooled (τ, σ) + symmetric (p, q) coverage surface
│   ├── build-surface-grid-validation.js     canonical step 4: §6.6.2 body comparison (grid calendar start, 2017-12-16)
│   ├── derive-mech-chart-data.js            figure-data: per-scenario min mechanical BCR for Figures 2 + B1
│   ├── bake-viewer.js                       regenerates bcr_3d_viewer.html from outputs/surface_grid.csv
│   └── lib/                                 pipeline helpers (engine loader, runner, aggregator, …)
├── figures/                                 paper-cited canonical PNGs (fig01–fig07, figB1, figB2)
├── data/
│   ├── README.md                            source URLs, licensing, hashes, attribution
│   ├── btc-prices-bitstamp.csv              preprocessed Bitstamp daily close (5,344 rows)
│   ├── btc-prices-bitstamp-imputation.json  imputation audit log
│   ├── btc-prices-coinmetrics.csv           CoinMetrics community reference rate (1,668 rows)
│   └── raw/
│       └── bitstamp_btc_prices.csv         raw Bitstamp export (5,311 rows; preprocessor input)
└── outputs/
    ├── manifest.json                        full methodology, hashes, schema (monthly cadence)
    ├── regime_summary.csv                   one row per (regime, starting BCR), the headline
    ├── regime_descriptors.csv               one row per regime: peak/trough/recovery dates and threshold brackets
    ├── bcr_paths_monthly.csv                month-end + event-day path snapshots
    ├── transition_paths_monthly.csv         transition-zone scenarios for path-shape inspection
    ├── min_bcr_chart_data_mech.csv          per-scenario min mechanical-continuation BCR (Figures 2 + B1)
    ├── regime_tau_sigma.csv                 per-regime (τ, σ) + pool_n3 row (population std, ddof=0)
    ├── time_at_depth_distributions.csv      depth-normalized drawdown trajectory per regime-day
    ├── surface_grid.csv                     961-cell coverage surface (depth × duration)
    ├── surface_grid_validation.csv          four-regime §6.6.2 body comparison (grid calendar start, 2017-12-16)
    ├── surface_validation.csv               four-regime calendar-sensitivity check (per-regime peak-date calendar start)
    └── daily/                               daily-cadence sister run (paper §5.1 footnote 1)
        ├── manifest.json
        ├── regime_summary.csv
        ├── regime_descriptors.csv
        ├── bcr_paths_monthly.csv
        ├── transition_paths_monthly.csv
        └── min_bcr_chart_data_mech.csv
```

`bcr_paths_daily.csv` (the full per-day archival, ~750 MB monthly cadence / ~850 MB daily cadence) is **not bundled** because it exceeds GitHub's 100 MB per-file limit. It is regenerable from `node scripts/export.js`. Expected SHA-256 hashes are documented in `verify.sh`.

## Parameter cross-reference (paper Appendix C ↔ engine config)

| Paper § C term | Engine config key | Value |
|---|---|---|
| monthly payment cadence | `cadence` | `"monthly"` (default) or `"daily"` |
| Path truncation at first recovery | `pipeline_config.truncation_rule` | implemented in `scripts/lib/runner.js` |
| Mechanical continuation | `pipeline_config.mechanical_continuation` | implemented in `scripts/lib/runner.js` |

The stripped-model assumptions (zero cash reserve, zero OPEX, no deploy-at-decline rule, no post-recovery sell suppression, BTC-funded payments only) are hardcoded in `runSolvencyOnDailyPath` rather than exposed as config keys. See `src/solvency-engine.js` and paper §5.1.

The full data dictionary, per-column definitions, and the rename history from earlier drafts live in `outputs/manifest.json`.

## Citation

```
Fairbanks, J. (2026). Perpetual Preferred Equity Against Bitcoin:
A stripped-model backtest of the starting Bitcoin Coverage Ratios that clear observed Bitcoin drawdowns.
[Publisher / DOI / URL].
```

## Contact

Replication issues and code-level bugs: <https://github.com/jacksonfairbanks/perpetual-preferred-against-bitcoin-backtest/issues>

Paper discussion and feedback: [@LongGamma](https://x.com/LongGamma) on X.
