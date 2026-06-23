const path = require('path');
const fs = require('fs');

const { loadPriceSources } = require('./lib/prices');
const { REGIMES, resolveRegimeDates } = require('./lib/regimes');
const statsMod = require('./lib/stats');
const engine = require('./lib/engine');
const runnerMod = require('./lib/runner');
const aggregatorMod = require('./lib/aggregator');
const monthlyMod = require('./lib/monthly');
const writers = require('./lib/writers');
const { deriveMechChartData } = require('./derive-mech-chart-data');

function parseCadenceFromArgv(argv) {
    for (const a of argv.slice(2)) {
        if (a === '--cadence=daily' || a === '--cadence=monthly') return a.split('=')[1];
        if (a.startsWith('--cadence=')) {
            throw new Error("Invalid --cadence value: " + a + " (allowed: monthly, daily)");
        }
    }
    if (process.env.EXPORT_CADENCE === 'daily' || process.env.EXPORT_CADENCE === 'monthly') {
        return process.env.EXPORT_CADENCE;
    }
    return 'monthly';
}
const CADENCE = parseCadenceFromArgv(process.argv);

const BASE_OUTPUT_DIR = path.resolve(__dirname, '..', 'outputs');
const OUTPUT_DIR = CADENCE === 'daily' ? path.join(BASE_OUTPUT_DIR, 'daily') : BASE_OUTPUT_DIR;

const SCHEMA_VERSION = 1;
const CODE_VERSION = 'exposure-export-v2.1.0';
const RUN_TIMESTAMP = new Date().toISOString();

function buildSweepGrid() {
    const set = new Set();
    for (let i = 1; i <= 100; i++) set.add(i);
    for (const v of [8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5]) set.add(v);
    const densifyRange = (start, end, step) => {
        for (let v = start; v <= end + 1e-9; v += step) {
            const rounded = Math.round(v * 10) / 10;
            set.add(rounded);
        }
    };
    densifyRange(1.0, 2.0, 0.1);
    densifyRange(2.0, 3.0, 0.1);
    densifyRange(3.0, 4.0, 0.1);
    densifyRange(6.0, 7.0, 0.1);
    densifyRange(7.0, 8.0, 0.1);
    densifyRange(8.0, 9.0, 0.1);
    densifyRange(9.0, 10.0, 0.1);
    densifyRange(10.0, 12.0, 0.1);
    densifyRange(13.0, 20.0, 0.1);
    const grid = [...set].sort((a, b) => a - b);
    return grid;
}

async function main() {
    console.log('===========================================================');
    console.log('Empirical Exposure -- Research Data Export');
    console.log('Run timestamp:', RUN_TIMESTAMP);
    console.log('Code version:', CODE_VERSION);
    console.log('Schema version:', SCHEMA_VERSION);
    console.log('Node version:', process.version);
    console.log('===========================================================');
    console.log();

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const priceSources = loadPriceSources();
    for (const [key, src] of Object.entries(priceSources)) {
        console.log('Prices [' + key + ']: ' + src.meta.rowCount + ' rows ('
            + src.meta.dateRange[0] + ' -> ' + src.meta.dateRange[1] + ')  sha256=' + src.meta.sha256);
    }
    const priceMeta = priceSources.bitstamp.meta;
    console.log('Engine sha256:', engine.engineSha256);
    console.log('Cadence:', CADENCE);
    console.log('Output dir:', OUTPUT_DIR);
    console.log();

    const sweepGrid = buildSweepGrid();
    console.log('Sweep grid (' + sweepGrid.length + ' values):',
        sweepGrid.map(v => Number.isInteger(v) ? String(v) : v.toFixed(1)).join(', '));
    console.log();

    const allScenarios = [];
    const regimeDescriptors = [];
    const regimesMetaForManifest = [];

    for (const rDef of REGIMES) {
        const resolved = resolveRegimeDates(rDef);
        const sourceKey = rDef.dataSource || 'bitstamp';
        const sourceForRegime = priceSources[sourceKey];
        if (!sourceForRegime) throw new Error('Unknown dataSource for regime ' + rDef.id + ': ' + sourceKey);
        const priceRows = sourceForRegime.rows;
        const peakIdxInFull = statsMod.findPeakIndex(priceRows, resolved.peakSearchStartDate, resolved.peakSearchEndDate);
        const peakRow = priceRows[peakIdxInFull];
        const windowEndDate = resolved.windowEndAfterPeak(peakRow.date);
        const regimeRows = statsMod.sliceByWindow(priceRows, peakIdxInFull, windowEndDate);

        console.log('[' + rDef.id + ' src=' + sourceKey + '] peak=' + peakRow.dateStr + ' ($' + peakRow.priceUsd.toFixed(2)
            + '), window=' + regimeRows[0].dateStr + ' -> ' + regimeRows[regimeRows.length - 1].dateStr
            + ' (' + regimeRows.length + ' days)');

        const { strip, prices, dates } = runnerMod.buildRegimeStrip(regimeRows, peakIdxInFull, regimeRows);

        const regimeScenarios = [];
        for (const startingBcr of sweepGrid) {
            const sc = runnerMod.runScenario(rDef.id, startingBcr, strip, dates, prices, CADENCE);
            regimeScenarios.push(sc);
        }

        const brackets = aggregatorMod.computeRegimeBrackets(regimeScenarios);
        console.log('  bracket primary (BCR<1x): lo=' + brackets.primary_lo + ' hi=' + brackets.primary_hi
            + ' | bracket terminal: lo=' + brackets.terminal_lo + ' hi=' + brackets.terminal_hi);

        const descriptor = aggregatorMod.buildRegimeDescriptor(rDef, regimeRows, peakIdxInFull, regimeScenarios, brackets);
        regimeDescriptors.push(descriptor);

        for (const sc of regimeScenarios) {
            sc._summaryRow = aggregatorMod.buildScenarioSummaryRow(sc, regimeRows.length - 1, brackets);
        }

        allScenarios.push(...regimeScenarios);

        regimesMetaForManifest.push({
            id: rDef.id,
            label: rDef.label,
            data_source: sourceKey,
            peak_search_window: [rDef.peakSearchStart, rDef.peakSearchEnd],
            regime_length_years: rDef.regimeLengthYears,
            resolved_peak_date: peakRow.dateStr,
            resolved_peak_price_usd: peakRow.priceUsd,
            regime_days: regimeRows.length,
            scenarios: sweepGrid.length,
            selection_rationale: rDef.selection_rationale,
        });
    }

    console.log();
    console.log('Writing output files to ' + OUTPUT_DIR + ' ...');

    const dailyRows = [];
    for (const sc of allScenarios) dailyRows.push(...sc.rows);
    const dailyRes = writers.writeCsv(
        path.join(OUTPUT_DIR, 'bcr_paths_daily.csv'),
        runnerMod.LONG_CSV_COLUMNS,
        dailyRows
    );
    console.log('  bcr_paths_daily.csv: ' + dailyRes.rowCount + ' rows ('
        + (dailyRes.byteLength / 1024 / 1024).toFixed(2) + ' MB)');

    const monthlyRows = [];
    for (const sc of allScenarios) monthlyRows.push(...monthlyMod.condenseScenarioToMonthly(sc));
    const monthlyRes = writers.writeCsv(
        path.join(OUTPUT_DIR, 'bcr_paths_monthly.csv'),
        runnerMod.LONG_CSV_COLUMNS,
        monthlyRows
    );
    console.log('  bcr_paths_monthly.csv: ' + monthlyRes.rowCount + ' rows ('
        + (monthlyRes.byteLength / 1024 / 1024).toFixed(2) + ' MB)');

    const summaryRows = allScenarios.map(sc => sc._summaryRow);
    const summaryRes = writers.writeCsv(
        path.join(OUTPUT_DIR, 'regime_summary.csv'),
        aggregatorMod.SUMMARY_COLUMNS,
        summaryRows
    );
    console.log('  regime_summary.csv: ' + summaryRes.rowCount + ' rows ('
        + (summaryRes.byteLength / 1024).toFixed(1) + ' KB)');

    const descriptorRes = writers.writeCsv(
        path.join(OUTPUT_DIR, 'regime_descriptors.csv'),
        aggregatorMod.DESCRIPTOR_COLUMNS,
        regimeDescriptors
    );
    console.log('  regime_descriptors.csv: ' + descriptorRes.rowCount + ' rows ('
        + (descriptorRes.byteLength / 1024).toFixed(1) + ' KB)');

    const manifest = buildManifest({
        priceMeta,
        priceSourcesMeta: {
            bitstamp: priceSources.bitstamp.meta,
            coinmetrics_2011: priceSources.coinmetrics_2011.meta,
        },
        engineMeta: {
            path: engine.enginePath,
            sha256: engine.engineSha256,
            byteLength: engine.engineByteLength,
        },
        regimesMeta: regimesMetaForManifest,
        regimeDescriptors,
        sweepGrid,
        dailyRowCount: dailyRes.rowCount,
        monthlyRowCount: monthlyRes.rowCount,
        summaryRowCount: summaryRes.rowCount,
        descriptorRowCount: descriptorRes.rowCount,
    });
    const manifestRes = writers.writeJson(path.join(OUTPUT_DIR, 'manifest.json'), manifest);
    console.log('  manifest.json: ' + (manifestRes.byteLength / 1024).toFixed(1) + ' KB');

    writeTransitionPathsCsv({
        OUTPUT_DIR,
        regimeDescriptors,
        allScenarios,
        sweepGrid,
    });

    console.log();
    console.log('Deriving min_bcr_chart_data_mech.csv from bcr_paths_daily.csv ...');
    await deriveMechChartData({ cadence: CADENCE });

    console.log();
    console.log('===========================================================');
    console.log('SCHEMA PREVIEW (20-row head of each CSV)');
    console.log('===========================================================');
    for (const fname of ['bcr_paths_daily.csv', 'bcr_paths_monthly.csv', 'regime_summary.csv', 'regime_descriptors.csv']) {
        console.log();
        console.log('---- ' + fname + ' ----');
        console.log(writers.headOfCsv(path.join(OUTPUT_DIR, fname), 20));
    }

    console.log();
    console.log('===========================================================');
    console.log('Done.');
    console.log('===========================================================');
}

function buildManifest(ctx) {
    return {
        schema_version: SCHEMA_VERSION,
        code_version: CODE_VERSION,
        run_timestamp: RUN_TIMESTAMP,

        failure_definitions: {
            primary: "BCR < 1x (forward solvency threshold -- first point at which reserve asset marked to current price cannot cover one forward year of obligation)",
            primary_justification: [
                "balance-sheet-native: perpetual preferred is a coverage instrument, coverage is its native metric",
                "mathematical: first point of forward insolvency for the reserve-to-obligation ratio"
            ],
            secondary: "terminal liquidity (btc_value_usd < monthly_obligation_usd, equivalently cumulative_btc_sold_fraction >= 1.0) -- mechanical floor, reported alongside primary",
            terminal_state_precedence: ["failed_terminal", "failed_primary", "recovered", "censored"],
            terminal_state_semantics: {
                failed_terminal: "path reached terminal liquidity at any point within the scenario window",
                failed_primary: "path hit BCR < 1x (primary failure, paper §4.1) but did not reach terminal liquidity before truncation",
                recovered:      "path's BTC reserve value returned to its initial level (equivalently BCR returned to starting_bcr) without failing or going terminal",
                censored:       "scenario window ended with no failure, no terminal liquidity, and no recovery -- should not arise for the selected regimes, but reserved"
            }
        },

        metrics: {
            bitcoin_coverage_ratio: {
                definition: "BTC reserve value / annual dividend obligation, evaluated daily. Industry-standard name for the metric; 'BCR' is the abbreviation used throughout.",
                formula: "bitcoin_coverage_ratio = (btc_held * price_usd) / annual_obligation_usd",
                aliases: ["bcr"],
                naming_note: "Earlier drafts called this 'balance_sheet_coverage_ratio' on the theory that it might one day include a cash component. Since this paper models a pure-BTC reserve, 'Bitcoin Coverage Ratio' is the accurate term and matches industry convention."
            },
            cash_coverage_ratio: {
                definition: "cash reserve / annual dividend obligation, reserved for a future sweep that introduces cash",
                formula: "cash_coverage_ratio = cash_usd / annual_obligation_usd",
                note: "Constant 0 in this sweep. Reserved-for-future-sweeps."
            },
            cash_buffer_months: {
                definition: "cash runway at current monthly obligation level",
                formula: "cash_buffer_months = cash_usd / monthly_obligation_usd",
                note: "Constant 0 in this sweep. Reserved-for-future-sweeps."
            },
            primary_to_terminal_gap_days: {
                definition: "calendar days between primary failure (BCR < 1x) and terminal liquidity on the same path. Paper §4.3, §6.4.",
                framing: "robustness diagnostic on the primary failure definition, not an operational metric. Quantifies definitional conservatism of BCR < 1x relative to the mechanical floor.",
                interpretation_note: "Gap magnitude is a function of drawdown shape. Steep, short drawdowns compress the gap (forward coverage and mechanical liquidity collapse together). Long, grinding drawdowns widen it (forward coverage deteriorates faster than the stack physically drains). Cross-regime comparison requires regime-shape context.",
                null_semantics: "null if either event did not fire within the scenario window",
                tracks: "Primary failure is evaluated on the engine's bitcoin_coverage_ratio path (which freezes at failure). Terminal liquidity is evaluated on a parallel mechanical continuation (btc_held_mechanical path) that keeps amortizing past the primary-failure event to locate the day the reserve asset physically cannot clear the next monthly dividend. The two events are intentionally measured on distinct trajectories: primary on the 'firm as modeled', secondary as a counterfactual mechanical floor.",
                renamed_from: "solvency_to_liquidity_gap_days (older vocabulary; superseded by paper's primary-to-terminal framing)"
            },
            drawdown_shape_ratio: {
                formula: "max_drawdown_from_peak / days_peak_to_trough",
                units: "fraction per day",
                interpretation: "Higher values indicate steeper, shorter drawdowns. Lower values indicate longer, grinding drawdowns. Intended for sorting and cross-regime comparison, not standalone interpretation."
            },
            btc_price_regime_pctile: {
                definition: "position of today's price within the full regime window's realized distribution",
                formula: "(price_usd - regime_min_price) / (regime_max_price - regime_min_price)",
                anchors: "0 at regime trough, 1 at regime peak"
            }
        },

        estimators: {
            day_counting: {
                day_index: "row index within the regime slice, 0-indexed at the regime peak",
                days_from_peak: "calendar days (integer) from the regime's peak date to the current row's date, computed via millisecond date arithmetic",
                all_days_to_X_fields: "calendar days (integer) from the regime's peak date to event X. Use calendar days so the paper's durations match the canonical historical timeline rather than the CSV row count.",
                note: "The two can differ when the price CSV is missing a trading day. All summary and descriptor duration metrics are calendar-day based; day_index is retained only for slice positioning."
            },
            daily_return: {
                method: "arithmetic simple return",
                formula: "price_usd[t] / price_usd[t-1] - 1",
                missing: "null on the first row of each scenario"
            },
            realized_vol_30d: {
                method: "close-to-close log returns",
                window: "30 calendar days",
                annualization: "sqrt(365) (BTC trades 7 days/week; calendar-day convention, not equity 252-day)",
                formula: "sqrt(sample_variance(log(p_t/p_{t-1}), 30d)) * sqrt(365)",
                missing: "null until the 30-day window first fills"
            },
            is_payment_day: {
                convention: CADENCE === 'daily' ? "every calendar day" : "calendar month-end",
                implementation: CADENCE === 'daily'
                    ? "true on every row (cadence='daily' path through src/solvency-engine.js:runSolvencyOnDailyPath)"
                    : "true on the last calendar day of each month (matches src/solvency-engine.js:isLastDayOfMonth)"
            },
            btc_sold_today_fraction_execution: {
                convention: "same-day close price",
                note: "Dividend obligation on a payment day is converted to BTC at the day's close price (no intra-day VWAP, no next-day open)"
            },
            dividend_convention: {
                div_rate: runnerMod.DIV_RATE,
                annualization: "annual_obligation_usd = btc_reserve_initial_usd / starting_bcr (equivalently btc_reserve_initial_usd * amplification * div_rate with amplification = 1 / (starting_bcr * div_rate))",
                monthly_draw: "exact monthly payment = annual_obligation_usd / 12; no accrual/payment distinction",
                note: "Since BCR depends only on the product amplification * div_rate (with OPEX = 0), starting_bcr fully parameterizes the obligation schedule. div_rate is carried for dollar-sanity columns only."
            }
        },

        dollar_anchor: {
            btc_reserve_initial_usd: runnerMod.BTC_RESERVE_INITIAL_USD,
            div_rate: runnerMod.DIV_RATE,
            note: "Dollar columns are constructed from a $1B initial BTC reserve value and 10% dividend rate. All dimensionless columns (btc_reserve_index, btc_held_index, bitcoin_coverage_ratio, *_fraction, *_over_annual) are invariant to this anchor."
        },

        engine_config: {
            note: "Mirror of runSolvencyOnDailyPath's signature in src/solvency-engine.js. Only fields here correspond to real engine parameters. Pipeline-level behavior (truncation, mechanical continuation, recovery) lives in pipeline_config below; stripped-model assumptions that have no engine parameter (e.g. zero OPEX) live in out_of_scope.",
            cadence: CADENCE,
            cadence_semantics: CADENCE === 'daily'
                ? "payment fires every calendar day at the daily close; per-payment amount = annual_obligation_usd / 365 (leap-year normalization: 365-day year, no 366 adjustment; effect well below 0.1x threshold resolution)"
                : "payment fires once per month on the last calendar day of the month; per-payment amount = annual_obligation_usd / 12",
            reproduction_command: CADENCE === 'daily'
                ? "cd scripts && node preprocess-bitstamp.js && node export.js --cadence=daily"
                : "cd scripts && node preprocess-bitstamp.js && node export.js"
        },

        pipeline_config: {
            note: "Behavior layered on top of the engine by scripts/lib/runner.js. Not engine parameters; documenting them here keeps engine_config a faithful mirror of the engine's signature.",
            truncation_rule: "slice at first recovery day (first day the BTC reserve value returns to its initial level after an initial dip below) if recovered; otherwise slice at regime window end. Terminal liquidity fires inside the slice or not at all -- the slice is not extended to chase it.",
            mechanical_continuation: "Alongside the engine simulation, a parallel mechanical continuation is computed on the same price/date series. The mechanical path keeps amortizing monthly dividends from BTC every calendar month-end until BTC is exhausted, ignoring the engine's BCR<1x freeze. It produces the btc_held_mechanical family of columns and is the basis for is_terminal_liquidity_day / has_reached_terminal_liquidity / days_to_terminal_liquidity.",
            recovery_semantics: "recoveryDay = first day btc_reserve_index >= 1.0 that occurs after at least one earlier day with btc_reserve_index < 1.0. Day 0 (btc_reserve_index = 1.0 trivially) never counts as recovery."
        },

        sweep_grid: {
            values: ctx.sweepGrid,
            count: ctx.sweepGrid.length,
            integer_range: "1..100",
            half_step_densifiers: [8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5],
            tenth_step_densifier_zones: [
                { range: [1.0, 2.0], motivation: "Terminal-liquidity transition zone for 2013 April + 2020 COVID" },
                { range: [2.0, 3.0], motivation: "BCR<1x transition zone for 2020 COVID" },
                { range: [3.0, 4.0], motivation: "BCR<1x transition zone for 2013 April flash crash" },
                { range: [6.0, 7.0], motivation: "Terminal-liquidity transition zone for 2022 Fed tightening" },
                { range: [7.0, 8.0], motivation: "BCR<1x transition zone for 2022 Fed tightening" },
                { range: [8.0, 9.0], motivation: "Terminal-liquidity transition zone for 2018 ICO bubble" },
                { range: [9.0, 10.0], motivation: "Terminal-liquidity transition zone for 2014 Mt. Gox" },
                { range: [10.0, 12.0], motivation: "BCR<1x transition zones for 2014 Mt. Gox + 2018 ICO" },
                { range: [13.0, 20.0], motivation: "BCR<1x transition zone for 2011 (deepest drawdown => highest threshold)" }
            ],
            densifier_rationale: "Integer grid resolves survival thresholds to within 1 BCR unit everywhere; 0.1-step densifier zones resolve each regime's BCR<1x and terminal-liquidity transition boundaries to 0.1 BCR units. Both primary (BCR<1x) and secondary (terminal liquidity) thresholds are now resolved to 0.1 for every regime."
        },

        regimes: ctx.regimesMeta,

        regime_results: ctx.regimeDescriptors.map(d => ({
            regime: d.regime,
            peak_date: d.peak_date,
            peak_price_usd: d.peak_price_usd,
            trough_date: d.trough_date,
            trough_price_usd: d.trough_price_usd,
            max_drawdown_from_peak: d.max_drawdown_from_peak,
            days_peak_to_trough: d.days_peak_to_trough,
            drawdown_shape_ratio: d.drawdown_shape_ratio,
            recovery_date: d.recovery_date,
            days_peak_to_recovery: d.days_peak_to_recovery,
            required_starting_bcr_lo: d.required_starting_bcr_lo,
            required_starting_bcr_hi: d.required_starting_bcr_hi,
            required_starting_bcr_terminal_lo: d.required_starting_bcr_terminal_lo,
            required_starting_bcr_terminal_hi: d.required_starting_bcr_terminal_hi
        })),

        regime_selection: {
            rule: "Real BTC drawdowns with distinct macro character across available price history: the 2011 early-market collapse (CoinMetrics; deepest drawdown on record), the 2013 April flash crash (fastest major drawdown on record; steepest shape ratio), the 2014 Mt. Gox counterparty failure (longest peak-to-recovery), the 2018 ICO bubble unwind (speculative unwind), the 2020 COVID cross-asset liquidity shock (steep short tail), and the 2022 Fed tightening drawdown (policy-driven macro regime).",
            per_regime_rationale: "See selection_rationale field in regime_descriptors.csv"
        },

        reproducibility: {
            random_seed: null,
            engine_determinism: true,
            price_sources: {
                bitstamp: {
                    path: ctx.priceSourcesMeta.bitstamp.path,
                    sha256: ctx.priceSourcesMeta.bitstamp.sha256,
                    row_count: ctx.priceSourcesMeta.bitstamp.rowCount,
                    date_range: ctx.priceSourcesMeta.bitstamp.dateRange,
                    byte_length: ctx.priceSourcesMeta.bitstamp.byteLength,
                    exchange: "Bitstamp",
                    column: "close",
                    used_by_regimes: ["apr_2013", "mtgox_2014", "ico_2018", "covid_2020", "fed_2022"],
                    timezone: "naive YYYY-MM-DD strings; each date is treated as one calendar day with the reported close price. No intra-day semantics.",
                    close_convention: "reported price is treated as the daily close; no exchange-local offset applied",
                    preprocessing: {
                        raw_source_file: "bitstamp_btc_prices.csv",
                        preprocessor: "scripts/preprocess-bitstamp.js",
                        imputation: {
                            method: "last_observation_carried_forward",
                            purpose: "Bitstamp has sparse early trading days (primarily 2011-2012). LOCF imputes the most recent prior close for each missing calendar day so that every calendar month-end exists in the series and monthly dividend payments fire on schedule. Without LOCF some payment days would be silently skipped, understating stress for early regimes.",
                            imputation_log: "data/btc-prices-bitstamp-imputation.json"
                        }
                    }
                },
                coinmetrics_2011: {
                    path: ctx.priceSourcesMeta.coinmetrics_2011.path,
                    sha256: ctx.priceSourcesMeta.coinmetrics_2011.sha256,
                    row_count: ctx.priceSourcesMeta.coinmetrics_2011.rowCount,
                    date_range: ctx.priceSourcesMeta.coinmetrics_2011.dateRange,
                    byte_length: ctx.priceSourcesMeta.coinmetrics_2011.byteLength,
                    source: "CoinMetrics community reference-rate BTC/USD daily series",
                    column: "close (CoinMetrics ReferenceRateUSD)",
                    used_by_regimes: ["early_2011"],
                    rationale: "Bitstamp price data begins 2011-08-18, after the canonical June 2011 peak (~$29). CoinMetrics extends back through the 2011 cycle peak on 2011-06-08, making the early-2011 regime anchorable on the actual peak price rather than a post-peak local high.",
                    notes: "CoinMetrics provides 7-day-a-week calendar-complete daily prices; no additional preprocessing or imputation applied. Several sequences of repeated prices in 2011 appear to reflect low-liquidity reference prices carried forward by CoinMetrics on days with no observed trades, not post-hoc imputation by this pipeline."
                }
            },
            engine: {
                path: ctx.engineMeta.path,
                sha256: ctx.engineMeta.sha256,
                byte_length: ctx.engineMeta.byteLength,
                function_used: "runSolvencyOnDailyPath",
                notes: "Canonical solvency engine is untouched; script loads it via Function() and invokes runSolvencyOnDailyPath with the engine_config above."
            },
            code_version: CODE_VERSION,
            schema_version: SCHEMA_VERSION,
            run_timestamp: RUN_TIMESTAMP,
            node_version: process.version
        },

        outputs: {
            'bcr_paths_daily.csv':     { rows: ctx.dailyRowCount,      description: "One row per (regime, starting_bcr, day), peak -> first recovery-or-regime-end inclusive. Full archival." },
            'bcr_paths_monthly.csv':   { rows: ctx.monthlyRowCount,    description: "Condensation of bcr_paths_daily: last calendar day of each month plus path start, path end, and event days (trough, bcr_min, recovery, BCR<1x failure, terminal liquidity). Deduped by (scenario_id, date)." },
            'regime_summary.csv':      { rows: ctx.summaryRowCount,    description: "One row per scenario. Terminal state + event dates + failure-threshold brackets + integral/time-weighted metrics." },
            'regime_descriptors.csv':  { rows: ctx.descriptorRowCount, description: "One row per regime. Peak/trough/recovery anchors, drawdown_shape_ratio, bracket thresholds, selection_rationale." }
        },

        data_dictionary: {
            long_csv: runnerMod.LONG_CSV_COLUMNS,
            summary_csv: aggregatorMod.SUMMARY_COLUMNS,
            descriptor_csv: aggregatorMod.DESCRIPTOR_COLUMNS,
            renames_from_prior_drafts: {
                bcr: "bitcoin_coverage_ratio",
                balance_sheet_coverage_ratio: "bitcoin_coverage_ratio (dropped 'balance sheet' framing; reserve is pure BTC)",
                nav_over_nav0: "btc_reserve_index",
                nav_index: "btc_reserve_index (NAV/net-asset-value framing dropped; the column is the BTC reserve value indexed to its initial level -- paper §3 'BTC reserve value')",
                nav_usd: "btc_reserve_usd (BTC reserve value in USD; NAV framing dropped)",
                nav_initial_usd: "btc_reserve_initial_usd (initial BTC reserve value anchor; NAV framing dropped)",
                terminal_nav_index: "terminal_btc_reserve_index",
                btc_at_peak_given_1b_nav: "btc_at_peak_given_1b_reserve",
                btc_over_btc0: "btc_held_index",
                btc_coverage_ratio: "bitcoin_coverage_ratio (was previously renamed to btc_only_coverage_ratio; now unified back)",
                btc_only_coverage_ratio: "dropped (redundant with bitcoin_coverage_ratio)",
                cash_only_coverage_ratio: "cash_coverage_ratio",
                is_failure_day: "is_primary_failure_day (paper §4.1 vocabulary; symmetric with is_terminal_liquidity_day)",
                has_failed: "has_failed_primary",
                days_to_failure: "days_to_primary_failure",
                failure_date: "primary_failure_date",
                solvency_to_liquidity_gap_days: "primary_to_terminal_gap_days (paper §4.3 / §6.4 vocabulary)",
                failure_threshold_bcr1x_lo: "required_starting_bcr_lo",
                failure_threshold_bcr1x_hi: "required_starting_bcr_hi",
                failure_threshold_terminal_lo: "required_starting_bcr_terminal_lo",
                failure_threshold_terminal_hi: "required_starting_bcr_terminal_hi",
                primary_threshold_lo: "required_starting_bcr_lo (paper Appendix D 'required starting BCR'; primary-failure sense, BCR<1x)",
                primary_threshold_hi: "required_starting_bcr_hi (paper Appendix D 'required starting BCR'; primary-failure sense, BCR<1x)",
                terminal_threshold_lo: "required_starting_bcr_terminal_lo (paper Appendix D 'required starting BCR (terminal liquidity)')",
                terminal_threshold_hi: "required_starting_bcr_terminal_hi (paper Appendix D 'required starting BCR (terminal liquidity)')",
                starting_bcr_primary_threshold: "required_starting_bcr (surface_grid.csv; synthetic required starting BCR clearing primary failure, BCR<1x)",
                starting_bcr_terminal_threshold: "required_starting_bcr_terminal (surface_grid.csv)",
                historical_primary_threshold: "historical_required_starting_bcr (surface_validation.csv / surface_grid_validation.csv)",
                synthetic_primary_threshold: "synthetic_required_starting_bcr (surface_validation.csv / surface_grid_validation.csv)",
                "terminal_state value 'failed_bcr1x'": "failed_primary"
            }
        },

        out_of_scope: [
            "OPEX modeling (no engine parameter; stripped-model framing means dividends are funded entirely from BTC sales with no operating overhead -- paper §5.1)",
            "spot model benchmark (reconstructible as price_normalized)",
            "BTC-denominated dividend growth dynamics (paper two material)",
            "sellBtcAfterRecovery modeling (artifact of a prior study; not exercised)",
            "post-recovery modeling (path truncated at first recovery day)",
            "efficient frontier sweep",
            "behavioral repricing and dividend-deferral thresholds (paper §4.4)",
            "macro tables, Plotly charts, UI modals, tooltip portal, Excel exporters"
        ]
    };
}

function writeTransitionPathsCsv(ctx) {
    const referenceBcrs = new Set([1, 5, 15, 25, 50]);
    const keepScenarioIds = new Set();
    for (const desc of ctx.regimeDescriptors) {
        const lo = desc.required_starting_bcr_lo, hi = desc.required_starting_bcr_hi;
        const tlo = desc.required_starting_bcr_terminal_lo, thi = desc.required_starting_bcr_terminal_hi;
        const zoneMin = Math.min(
            (lo != null ? lo - 1 : Infinity),
            (tlo != null ? tlo - 1 : Infinity)
        );
        const zoneMax = Math.max(
            (hi != null ? hi + 1 : -Infinity),
            (thi != null ? thi + 1 : -Infinity)
        );
        for (const bcr of ctx.sweepGrid) {
            if (referenceBcrs.has(bcr) || (bcr >= zoneMin && bcr <= zoneMax)) {
                keepScenarioIds.add(desc.regime + '_bcr' + bcr.toFixed(1));
            }
        }
    }

    const rows = [];
    for (const sc of ctx.allScenarios) {
        if (!keepScenarioIds.has(sc.scenarioId)) continue;
        rows.push(...monthlyMod.condenseScenarioToMonthly(sc));
    }

    const res = writers.writeCsv(
        path.join(ctx.OUTPUT_DIR, 'transition_paths_monthly.csv'),
        runnerMod.LONG_CSV_COLUMNS,
        rows
    );
    console.log('  transition_paths_monthly.csv: ' + keepScenarioIds.size + ' scenarios, ' + res.rowCount + ' rows, ' + (res.byteLength / 1024 / 1024).toFixed(2) + ' MB');
}

if (require.main === module) {
    main().catch(e => {
        console.error('ERROR: ' + e.message);
        process.exit(1);
    });
}
