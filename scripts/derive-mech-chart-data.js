// Derive min_bcr_chart_data_mech.csv from the daily-resolution mechanical-continuation
// columns in bcr_paths_daily.csv. Streams the (~750 MB) input line-by-line so it runs
// in constant memory.
//
// For each (regime, starting_bcr) scenario, walks every row of the path and records the
// minimum mechanical-continuation BCR:
//
//     bcr_mechanical = btc_value_usd_mechanical / annual_obligation_usd
//
// This is the value that drives Figure 2 (four main regimes) and Figure B1 (2011 regime,
// Appendix B) in the paper. The mechanical continuation amortizes monthly dividends past
// the engine's primary-failure freeze, producing a single signed-distance-to-floor metric
// per scenario.
//
// Output columns: regime, starting_bcr, min_bcr_mechanical
// Output sort: by regime (sorted ascending lexicographically), then by starting_bcr.
// Scope: 4 main regimes + early_2011, matching paper Figures 2 and 7. covid_2020 is
// included in the canonical sweep for robustness (paper §5.2) but is not a headline
// figure and is omitted here. To include it, pass --include=covid.
//
// Invocation: called from scripts/export.js's main() after the daily-resolution CSV
// is written, so the canonical chain regenerates this file in lockstep. Also runnable
// standalone for one-off rebuilds with the --include=covid flag:
//
//   node scripts/derive-mech-chart-data.js                       (monthly cadence; reads outputs/bcr_paths_daily.csv)
//   node scripts/derive-mech-chart-data.js --cadence=daily       (daily cadence; reads outputs/daily/bcr_paths_daily.csv)
//   node scripts/derive-mech-chart-data.js --include=covid       (include covid_2020 too; 6 regimes, 1,470 rows)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
    let cadence = 'monthly';
    let includeCovid = false;
    for (const a of argv.slice(2)) {
        if (a === '--cadence=daily') cadence = 'daily';
        else if (a === '--cadence=monthly') cadence = 'monthly';
        else if (a === '--include=covid') includeCovid = true;
        else throw new Error('Unknown arg: ' + a);
    }
    return { cadence, includeCovid };
}

const HEADLINE_REGIMES = new Set(['early_2011', 'apr_2013', 'mtgox_2014', 'ico_2018', 'fed_2022']);

async function deriveMechChartData({ cadence, includeCovid = false }) {
    const baseOut = path.resolve(__dirname, '..', 'outputs');
    const outDir = cadence === 'daily' ? path.join(baseOut, 'daily') : baseOut;
    const inputPath = path.join(outDir, 'bcr_paths_daily.csv');
    const outputPath = path.join(outDir, 'min_bcr_chart_data_mech.csv');

    if (!fs.existsSync(inputPath)) {
        throw new Error(
            'Input not found: ' + inputPath + '\n' +
            'Generate it first with: node scripts/export.js' +
            (cadence === 'daily' ? ' --cadence=daily' : '')
        );
    }

    console.log('Reading: ' + inputPath);
    console.log('Cadence: ' + cadence);
    console.log('Scope:   ' + (includeCovid ? '6 regimes (including covid_2020)' : '5 regimes (4 main + early_2011)'));

    const stream = fs.createReadStream(inputPath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header = null;
    let idxRegime, idxStartingBcr, idxBtcValueMech, idxAnnualObl;

    // Map: scenarioKey -> { regime, startingBcr, minBcrMech }
    const minByScenario = new Map();
    let lineCount = 0;

    for await (const raw of rl) {
        if (lineCount === 0) {
            header = raw.split(',');
            idxRegime         = header.indexOf('regime');
            idxStartingBcr    = header.indexOf('starting_bcr');
            idxBtcValueMech   = header.indexOf('btc_value_usd_mechanical');
            idxAnnualObl      = header.indexOf('annual_obligation_usd');
            for (const [name, idx] of [
                ['regime', idxRegime],
                ['starting_bcr', idxStartingBcr],
                ['btc_value_usd_mechanical', idxBtcValueMech],
                ['annual_obligation_usd', idxAnnualObl],
            ]) {
                if (idx < 0) throw new Error('Missing column: ' + name);
            }
            lineCount++;
            continue;
        }
        // Fast split: rows have no quoted commas (engine emits plain numerics + ISO dates)
        const cells = raw.split(',');
        const regime = cells[idxRegime];
        if (!HEADLINE_REGIMES.has(regime) && !(includeCovid && regime === 'covid_2020')) {
            lineCount++;
            continue;
        }
        const startingBcrStr = cells[idxStartingBcr];
        const btcValMech = Number(cells[idxBtcValueMech]);
        const annualObl  = Number(cells[idxAnnualObl]);
        if (!Number.isFinite(btcValMech) || !Number.isFinite(annualObl) || annualObl <= 0) {
            lineCount++;
            continue;
        }
        const bcrMech = btcValMech / annualObl;
        const key = regime + '|' + startingBcrStr;
        const existing = minByScenario.get(key);
        if (!existing) {
            minByScenario.set(key, {
                regime,
                startingBcr: Number(startingBcrStr),
                minBcrMech: bcrMech,
            });
        } else if (bcrMech < existing.minBcrMech) {
            existing.minBcrMech = bcrMech;
        }
        lineCount++;
        if (lineCount % 250000 === 0) {
            process.stdout.write('  scanned ' + lineCount + ' rows, scenarios so far: ' + minByScenario.size + '\r');
        }
    }
    process.stdout.write('\n');

    console.log('Scanned ' + lineCount + ' rows; ' + minByScenario.size + ' unique scenarios.');

    const rows = Array.from(minByScenario.values()).sort((a, b) => {
        if (a.regime < b.regime) return -1;
        if (a.regime > b.regime) return 1;
        return a.startingBcr - b.startingBcr;
    });

    // 4 decimal places for stable cross-platform hashing.
    const lines = ['regime,starting_bcr,min_bcr_mechanical'];
    for (const r of rows) {
        lines.push(r.regime + ',' + r.startingBcr + ',' + r.minBcrMech.toFixed(6));
    }
    const out = lines.join('\n') + '\n';
    fs.writeFileSync(outputPath, out, 'utf8');

    const perRegime = {};
    for (const r of rows) perRegime[r.regime] = (perRegime[r.regime] || 0) + 1;

    console.log('Wrote: ' + outputPath);
    console.log('Total rows: ' + rows.length);
    console.log('Per-regime row counts:');
    for (const k of Object.keys(perRegime).sort()) console.log('  ' + k + ': ' + perRegime[k]);
}

module.exports = { deriveMechChartData };

if (require.main === module) {
    deriveMechChartData(parseArgs(process.argv)).catch(e => {
        console.error('ERROR: ' + e.message);
        process.exit(1);
    });
}
