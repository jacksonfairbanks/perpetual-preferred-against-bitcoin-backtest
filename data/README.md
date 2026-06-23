# Price source data

Two BTC/USD daily-close series are used. The four main-results regimes (April 2013, Mt. Gox 2014, ICO Unwind 2018, Fed Tightening 2022) run on Bitstamp; the supplementary 2011 regime (Appendix B) runs on CoinMetrics because Bitstamp data begins after the June 2011 peak.

## Files

| Path | Source | Rows | Date range | SHA-256 |
|---|---|---|---|---|
| `btc-prices-bitstamp.csv` | Preprocessed Bitstamp daily close (LOCF-imputed) | 5,344 | 2011-08-18 → 2026-04-04 | `978ad50a50bf22be09d9a18b1517202d71f15cea7bed46d93e445a3af1810146` |
| `raw/bitstamp_btc_prices.csv` | Raw Bitstamp export (preprocessor input) | 5,311 | 2011-08-18 → 2026-04-04 | `94e9e11b9aa931fcbd64f1984b708206ec961133b1ef2b026717afcce5325c6b` |
| `btc-prices-bitstamp-imputation.json` | Audit log: which dates were imputed and why | — | — | (see `verify.sh`) |
| `btc-prices-coinmetrics.csv` | CoinMetrics community reference rate | 1,668 | 2011-06-08 → 2015-12-31 | `690e81b45a03c35b45a907a1baab2e44532f33ac4c5c5f152457f3c1b63e1eba` |

## Provenance

### Bitstamp daily close

- **Source:** Bitstamp (https://www.bitstamp.net/), the primary BTC/USD reference exchange for the 2013–present regimes.
- **Acquisition:** Bitstamp daily-close close-only OHLC export. The raw export is checked in at `data/raw/bitstamp_btc_prices.csv` (5,311 trading days). The preprocessor (`scripts/preprocess-bitstamp.js`) applies last-observation-carried-forward imputation for the 33 calendar-day gaps in the raw series, 31 of them in 2011-08 / 2011-09 (early-exchange operating gaps) plus 2 isolated days in later years. Imputed days are flagged in `btc-prices-bitstamp-imputation.json`.
- **Why imputation matters:** without LOCF, calendar-month-ends that fell on non-trading days would have no price, and the engine's monthly dividend payment would silently skip them. LOCF preserves the canonical historical timeline. Two month-ends (2011-08-31, 2011-09-30) are LOCF-imputed; their effect on the early-2011 required starting BCRs is documented in `outputs/manifest.json` → `reproducibility.price_sources.bitstamp.preprocessing`.
- **Used by regimes:** `apr_2013`, `mtgox_2014`, `ico_2018`, `covid_2020`, `fed_2022`.

### CoinMetrics community reference rate

- **Source:** Coin Metrics community network data (https://coinmetrics.io/community-network-data/), reference-rate BTC/USD daily series.
- **Acquisition:** CoinMetrics community CSV download for 2011-06-08 → 2015-12-31. Used to anchor the 2011 regime on the canonical June 2011 peak ($29.03 on 2011-06-08), which predates Bitstamp's 2011-08-18 start. No preprocessing applied; the community series is calendar-complete daily.
- **Used by regimes:** `early_2011` (paper Appendix B).

## Licensing

Reviewed before this artifact was assembled (May 2026); summary below. The paper's intended use is academic reproduction of derivative analyses (BCR ratios, threshold brackets, summary statistics), not redistribution of raw exchange data as a primary product.

### CoinMetrics

Coin Metrics community network data is published under a Creative Commons license (`https://docs.coinmetrics.io/packages/coin-metrics-community-data`). Redistribution is permitted with attribution, which this README provides.

**Attribution:** Coin Metrics community reference-rate BTC/USD daily series.

### Bitstamp

Bitstamp's public position permits the incorporation and redistribution of exchange data for commercial purposes, including the right to create ratios, calculations, new original works, statistics, and similar works based on the exchange data. Companies seeking to use the exchange data for their own commercial purposes are directed to contact `partners@bitstamp.net` for a Data License Agreement. No explicit prohibition exists on redistribution of derivative analyses or the underlying daily-close series for academic reproducibility purposes; this artifact bundles the data on that basis. Commercial users are encouraged to contact Bitstamp directly.

**Attribution:** Bitstamp daily close, BTC/USD pair.

## Re-acquiring the source files

If you ever need to re-pull the raw sources from scratch (e.g. to extend the regime set beyond 2026):

- **Bitstamp daily close:** export from a Bitstamp historical-data provider that mirrors official Bitstamp OHLC, or pull via the Bitstamp REST API (`/api/v2/ohlc/{pair}` with `step=86400`).
- **CoinMetrics:** download the community reference-rate CSV from `https://coinmetrics.io/community-network-data/` for the asset (`btc`) and metric (`PriceUSD`) of interest.

After re-pulling, run `node scripts/preprocess-bitstamp.js` to re-derive the imputed Bitstamp series, then `./verify.sh` to confirm the bundled hashes match.
