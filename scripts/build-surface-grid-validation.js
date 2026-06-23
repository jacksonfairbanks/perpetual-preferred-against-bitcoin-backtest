/*
 * Phase 2 -- grid-anchor validation export.
 *
 * Builds:
 *   outputs/surface_grid_validation.csv
 *
 * For each of the four validation regimes (apr_2013, mtgox_2014, ico_2018,
 * fed_2022), computes the synthetic required starting BCR using:
 *   - regime's own (depth, duration) from regime_descriptors.csv
 *   - POOLED (tau, sigma) from manifest.json (matching surface_grid.csv)
 *   - grid anchor calendar start date (2017-12-16, ICO Unwind 2018 peak,
 *     in-pool median across the three pool regimes) as the synthetic path's
 *     peak date, so payment-day cadence is deterministic and matches the
 *     surface_grid cells displayed in Figures 6 and 7
 *
 * Schema matches surface_validation.csv. Differs only in the calendar start
 * date convention: surface_grid_validation.csv (this file) is the §6.6.2 body
 * comparison; surface_validation.csv uses each regime's own peak date as the
 * calendar start and is retained as a calendar-sensitivity check.
 *
 * Reuses the synthetic family, solver, and bisection from build-surface.js
 * verbatim (copied, not imported, because build-surface.js does not export
 * these helpers). Engine call: monthly cadence, matching scripts/lib/runner.js.
 * No local override.
 *
 * Methodology locks (mirroring build-surface.js Phase 2 spec):
 *   pool composition       = [mtgox_2014, ico_2018, fed_2022]
 *   pool weighting         = unweighted mean of (tau, sigma)
 *   synthetic family       = symmetric two-parameter
 *                            base(t)     = (4t(1-t))^p
 *                            profile(t)  = 1 - (1 - base(t))^q
 *                            drawdown(t) = depth * profile(t)
 *   calendar convention    = grid anchor (2017-12-16) for every regime
 *   solver moment tol      = 0.005 absolute on (tau, sigma)
 *   bisection range        = starting BCR in [1.0, 100.0] at 0.1 resolution
 *
 * Run after build-surface.js, which must have populated phase_2.pool in the
 * manifest. Manifest update on this script: writes phase_2.sha256.surface_grid_validation.
 * Does not touch surface_grid.csv, the surface itself, or any of the other
 * phase_2.sha256 entries.
 *
 * Reproduce
 *   node scripts/build-surface-grid-validation.js
 *
 * Code attribution: GRID_VALIDATION_CODE_VERSION below. Recorded in the
 * script source only; not exposed as a new manifest field to keep the
 * phase_2 schema stable.
 */

const GRID_VALIDATION_CODE_VERSION = 'grid-validation-v1.0.0';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { parseIsoDate } = require('./lib/prices');
const engine = require('./lib/engine');
const runnerMod = require('./lib/runner');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'outputs');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const DESCRIPTORS_PATH = path.join(OUTPUT_DIR, 'regime_descriptors.csv');
const VALIDATION_OUT_PATH = path.join(OUTPUT_DIR, 'surface_grid_validation.csv');

const VALIDATION_REGIME_IDS = ['apr_2013', 'mtgox_2014', 'ico_2018', 'fed_2022'];
const POOL_REGIME_IDS = ['mtgox_2014', 'ico_2018', 'fed_2022'];
const SURFACE_GRID_ANCHOR_PEAK_DATE_STR = '2017-12-16';

const BTC_RESERVE_INITIAL_USD = runnerMod.BTC_RESERVE_INITIAL_USD;
const ENGINE_CADENCE = 'monthly';

const SOLVER_MOMENT_TOL = 0.005;
const BISECTION_RANGE_MIN = 1.0;
const BISECTION_RANGE_MAX = 100.0;
const BISECTION_STEPS_PER_UNIT = 10; // 0.1 resolution
const SYNTHETIC_PEAK_PRICE_USD = 100.0;

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function addDays(d, n) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
}

function meanAndPopulationStd(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, std: 0 };
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / n;
    let sq = 0;
    for (const v of values) { const d = v - mean; sq += d * d; }
    return { mean, std: Math.sqrt(sq / n) };
}

function buildSyntheticProfileArray(N, p, q) {
    const arr = new Array(N + 1);
    for (let i = 0; i <= N; i++) {
        const t = N === 0 ? 0 : i / N;
        const x = 4 * t * (1 - t);
        if (x <= 0) { arr[i] = 0; continue; }
        const base = Math.pow(x, p);
        arr[i] = 1 - Math.pow(1 - base, q);
    }
    return arr;
}

function buildSyntheticDrawdownArray(depth, N, p, q) {
    return buildSyntheticProfileArray(N, p, q).map(v => depth * v);
}

function solveQforTau(N, p, tauNormTarget, maxIter = 80) {
    let qLo = 1e-4, qHi = 1e4;
    const tauAtQLo = meanAndPopulationStd(buildSyntheticProfileArray(N, p, qLo)).mean;
    const tauAtQHi = meanAndPopulationStd(buildSyntheticProfileArray(N, p, qHi)).mean;
    if (tauNormTarget < tauAtQLo || tauNormTarget > tauAtQHi) return null;
    for (let iter = 0; iter < maxIter; iter++) {
        const qMid = Math.sqrt(qLo * qHi);
        const tauMid = meanAndPopulationStd(buildSyntheticProfileArray(N, p, qMid)).mean;
        if (tauMid < tauNormTarget) qLo = qMid;
        else qHi = qMid;
        if (Math.abs(Math.log(qHi / qLo)) < 1e-7) break;
    }
    return Math.sqrt(qLo * qHi);
}

function sigmaAtPwithTauPinned(N, p, tauNormTarget) {
    const q = solveQforTau(N, p, tauNormTarget);
    if (q == null) return null;
    const m = meanAndPopulationStd(buildSyntheticProfileArray(N, p, q));
    return { p, q, tau: m.mean, sigma: m.std };
}

function solvePQ(N, tauNormTarget, sigmaNormTarget, momentTol = SOLVER_MOMENT_TOL) {
    if (N <= 0) return null;
    if (tauNormTarget <= 0 || tauNormTarget >= 1) return null;

    const logPs = [];
    for (let lp = -3; lp <= 3 + 1e-9; lp += 0.25) logPs.push(Math.pow(10, lp));

    const valid = [];
    for (const p of logPs) {
        const s = sigmaAtPwithTauPinned(N, p, tauNormTarget);
        if (s != null) valid.push(s);
    }
    if (valid.length < 2) return null;

    let bracket = null;
    for (let i = 0; i < valid.length - 1; i++) {
        const lo = valid[i], hi = valid[i + 1];
        if ((lo.sigma <= sigmaNormTarget && sigmaNormTarget <= hi.sigma)
            || (hi.sigma <= sigmaNormTarget && sigmaNormTarget <= lo.sigma)) {
            bracket = { lo, hi };
            break;
        }
    }
    if (!bracket) {
        let best = valid[0];
        let bestErr = Math.max(Math.abs(best.sigma - sigmaNormTarget), Math.abs(best.tau - tauNormTarget));
        for (const s of valid) {
            const err = Math.max(Math.abs(s.sigma - sigmaNormTarget), Math.abs(s.tau - tauNormTarget));
            if (err < bestErr) { bestErr = err; best = s; }
        }
        if (bestErr <= momentTol) return best;
        return null;
    }

    let pLo = bracket.lo.p, pHi = bracket.hi.p;
    const sigmaIncreasingWithP = bracket.hi.sigma > bracket.lo.sigma;
    let best = null;
    let bestErr = Infinity;
    for (let iter = 0; iter < 80; iter++) {
        const pMid = Math.sqrt(pLo * pHi);
        const s = sigmaAtPwithTauPinned(N, pMid, tauNormTarget);
        if (s == null) { pHi = pMid; continue; }
        const errTau = Math.abs(s.tau - tauNormTarget);
        const errSigma = Math.abs(s.sigma - sigmaNormTarget);
        const err = Math.max(errTau, errSigma);
        if (err < bestErr) { bestErr = err; best = s; }
        if (sigmaIncreasingWithP) {
            if (s.sigma < sigmaNormTarget) pLo = pMid;
            else pHi = pMid;
        } else {
            if (s.sigma < sigmaNormTarget) pHi = pMid;
            else pLo = pMid;
        }
        if (Math.abs(Math.log(pHi / pLo)) < 1e-9) break;
    }
    if (best != null && bestErr <= momentTol) return best;
    return null;
}

function buildSyntheticPathAtAnchor(depth, N, p, q, anchorPeakDate, peakPriceUsd = SYNTHETIC_PEAK_PRICE_USD) {
    const drawdowns = buildSyntheticDrawdownArray(depth, N, p, q);
    const prices = drawdowns.map(dd => peakPriceUsd * (1 - dd));
    const dates = new Array(N + 1);
    for (let i = 0; i <= N; i++) dates[i] = addDays(anchorPeakDate, i);
    return { prices, dates };
}

function clearsPrimary(startingBcr, prices, dates) {
    const peakPrice = prices[0];
    const btc0 = BTC_RESERVE_INITIAL_USD / peakPrice;
    const annualObligationUsd = BTC_RESERVE_INITIAL_USD / startingBcr;
    const paymentObligationUsd = annualObligationUsd / 12;
    const res = engine.runSolvencyOnDailyPath(
        prices, dates, btc0, paymentObligationUsd, annualObligationUsd, ENGINE_CADENCE
    );
    return !res.failed;
}

function bisectLowestClearingBcr(prices, dates) {
    const loInt = Math.round(BISECTION_RANGE_MIN * BISECTION_STEPS_PER_UNIT);
    const hiInt = Math.round(BISECTION_RANGE_MAX * BISECTION_STEPS_PER_UNIT);
    if (clearsPrimary(loInt / BISECTION_STEPS_PER_UNIT, prices, dates)) {
        return { status: 'ok', threshold: loInt / BISECTION_STEPS_PER_UNIT };
    }
    if (!clearsPrimary(hiInt / BISECTION_STEPS_PER_UNIT, prices, dates)) {
        return { status: 'no_solution_in_range', threshold: null };
    }
    let lo = loInt, hi = hiInt;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (clearsPrimary(mid / BISECTION_STEPS_PER_UNIT, prices, dates)) hi = mid;
        else lo = mid;
    }
    const threshold = hi / BISECTION_STEPS_PER_UNIT;
    if (Math.abs(threshold - BISECTION_RANGE_MAX) < 1e-9) {
        return { status: 'hit_ceiling', threshold: null };
    }
    return { status: 'ok', threshold };
}

function parseCsvRow(line) {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
                else inQuotes = false;
            } else cur += ch;
        } else {
            if (ch === ',') { out.push(cur); cur = ''; }
            else if (ch === '"') inQuotes = true;
            else cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function writeCsv(filePath, columns, rows) {
    const lines = [columns.join(',')];
    for (const r of rows) {
        const parts = columns.map(c => {
            const v = r[c];
            if (v == null) return '';
            if (typeof v === 'boolean') return v ? 'true' : 'false';
            if (typeof v === 'number') {
                if (!Number.isFinite(v)) return '';
                if (Number.isInteger(v)) return String(v);
                return v.toString();
            }
            const s = String(v);
            if (s.includes(',') || s.includes('"') || s.includes('\n')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        });
        lines.push(parts.join(','));
    }
    const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(filePath, buf);
    return { rowCount: rows.length, byteLength: buf.length, sha256: sha256Hex(buf) };
}

function loadDescriptors() {
    const raw = fs.readFileSync(DESCRIPTORS_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    const header = parseCsvRow(lines[0]);
    const byRegime = {};
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
        const obj = {};
        header.forEach((h, j) => obj[h] = cols[j]);
        byRegime[obj.regime] = obj;
    }
    return byRegime;
}

function main() {
    console.log('===========================================================');
    console.log('Phase 2 -- Grid-anchor validation export');
    console.log('Code version:', GRID_VALIDATION_CODE_VERSION);
    console.log('Engine sha256:', engine.engineSha256);
    console.log('Anchor:', SURFACE_GRID_ANCHOR_PEAK_DATE_STR);
    console.log('===========================================================');

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (!manifest.phase_2 || !manifest.phase_2.pool) {
        throw new Error('manifest.phase_2.pool missing -- run build-surface.js first');
    }
    const pooledTau = manifest.phase_2.pool.pooled_tau;
    const pooledSigma = manifest.phase_2.pool.pooled_sigma;
    console.log('pooled_tau:   ' + pooledTau);
    console.log('pooled_sigma: ' + pooledSigma);
    console.log();

    const descriptorsByRegime = loadDescriptors();
    const anchorPeakDate = parseIsoDate(SURFACE_GRID_ANCHOR_PEAK_DATE_STR);

    const cols = ['regime', 'drawdown_fraction', 'duration_days',
                  'historical_required_starting_bcr', 'synthetic_required_starting_bcr',
                  'delta_bcr', 'abs_delta_bcr', 'in_pool'];
    const rows = [];
    let maxAbsDelta = -Infinity;

    for (const rid of VALIDATION_REGIME_IDS) {
        const desc = descriptorsByRegime[rid];
        if (!desc) throw new Error('Descriptor missing for regime ' + rid);
        const depth = Number(desc.max_drawdown_from_peak);
        const duration = Number(desc.days_peak_to_recovery);
        const histThreshold = Number(desc.required_starting_bcr_hi);

        const pq = solvePQ(duration, pooledTau, pooledSigma);
        if (pq == null) {
            console.log('  ' + rid + ': solver_no_convergence');
            rows.push({
                regime: rid,
                drawdown_fraction: depth,
                duration_days: duration,
                historical_required_starting_bcr: histThreshold,
                synthetic_required_starting_bcr: null,
                delta_bcr: null,
                abs_delta_bcr: null,
                in_pool: POOL_REGIME_IDS.includes(rid),
            });
            continue;
        }
        const syn = buildSyntheticPathAtAnchor(depth, duration, pq.p, pq.q, anchorPeakDate);
        const result = bisectLowestClearingBcr(syn.prices, syn.dates);
        const synThreshold = result.threshold;
        const delta = synThreshold != null
            ? (Math.round(synThreshold * 10) - Math.round(histThreshold * 10)) / 10
            : null;
        const absDelta = delta != null ? Math.abs(delta) : null;
        if (absDelta != null && absDelta > maxAbsDelta) maxAbsDelta = absDelta;

        console.log('  ' + rid.padEnd(11)
            + '  depth=' + depth.toFixed(4)
            + '  dur=' + String(duration).padStart(4)
            + '  hist=' + histThreshold.toFixed(1).padStart(5)
            + '  syn=' + (synThreshold != null ? synThreshold.toFixed(1).padStart(5) : 'null ')
            + '  delta=' + (delta != null ? delta.toFixed(2).padStart(6) : 'null')
            + '  (p=' + pq.p.toFixed(4) + ', q=' + pq.q.toFixed(4)
            + ', tau=' + pq.tau.toFixed(4) + ', sigma=' + pq.sigma.toFixed(4)
            + ', status=' + result.status + ')');

        rows.push({
            regime: rid,
            drawdown_fraction: depth,
            duration_days: duration,
            historical_required_starting_bcr: histThreshold,
            synthetic_required_starting_bcr: synThreshold,
            delta_bcr: delta,
            abs_delta_bcr: absDelta,
            in_pool: POOL_REGIME_IDS.includes(rid),
        });
    }

    const res = writeCsv(VALIDATION_OUT_PATH, cols, rows);
    console.log();
    console.log('Wrote ' + VALIDATION_OUT_PATH);
    console.log('  rows:    ' + res.rowCount);
    console.log('  bytes:   ' + res.byteLength);
    console.log('  sha256:  ' + res.sha256);
    console.log('  max(|delta_bcr|) = ' + maxAbsDelta.toFixed(4));
}

if (require.main === module) {
    main();
}
