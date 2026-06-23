/*
 * Phase 2 -- coverage surface construction.
 *
 * Builds:
 *   outputs/time_at_depth_distributions.csv
 *   outputs/regime_tau_sigma.csv
 *   outputs/surface_validation.csv
 *   outputs/surface_grid.csv
 *
 * Appends a phase_2 block to outputs/manifest.json. Does not touch the
 * top-level code_version or reproducibility.code_version fields: those are
 * the export.js release tag. This script records its own version inside
 * phase_2.surface_code_version so the surface build is attributable without
 * colliding with the release label.
 *
 * Methodology locks (per Phase 2 spec):
 *   pool composition       = [mtgox_2014, ico_2018, fed_2022]
 *   pool weighting         = unweighted mean of (tau, sigma)
 *   synthetic family       = symmetric two-parameter
 *                            base(t)     = (4t(1-t))^p
 *                            profile(t)  = 1 - (1 - base(t))^q
 *                            drawdown(t) = depth * profile(t)
 *   anchor convention      = peak-date calendar anchoring
 *   solver moment tol      = 0.005 absolute on (tau, sigma)
 *   bisection range        = starting BCR in [1.0, 100.0] at 0.1 resolution
 *   validation gate        = max(|synthetic - historical|) <= 0.5 across the
 *                            four in-validation regimes
 *
 * Validation gate margin
 * ----------------------
 *   Mt. Gox 2014 sits at |delta_bcr| = 0.50 exactly, i.e. on the gate
 *   limit. Passing is passing, but there is no numerical headroom on this
 *   regime. Any future refinement to anchor convention, depth definition,
 *   or pool composition could tip it. Do not tighten the gate without
 *   re-running validation; do not treat 0.50 as "loose."
 *
 * Engine call: monthly cadence, matching scripts/lib/runner.js. No local override.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { loadPriceSources, parseIsoDate } = require('./lib/prices');
const { REGIMES, resolveRegimeDates } = require('./lib/regimes');
const statsMod = require('./lib/stats');
const engine = require('./lib/engine');
const runnerMod = require('./lib/runner');
const writers = require('./lib/writers');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'outputs');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const SURFACE_CODE_VERSION = 'surface-build-v1.0.1';
const SCHEMA_VERSION = 1;
const RUN_TIMESTAMP = new Date().toISOString();

const POOL_REGIME_IDS = ['mtgox_2014', 'ico_2018', 'fed_2022'];
const SURFACE_REGIME_IDS = ['early_2011', 'apr_2013', 'mtgox_2014', 'ico_2018', 'fed_2022'];
const VALIDATION_REGIME_IDS = ['apr_2013', 'mtgox_2014', 'ico_2018', 'fed_2022'];

const BTC_RESERVE_INITIAL_USD = runnerMod.BTC_RESERVE_INITIAL_USD;
const ENGINE_CADENCE = 'monthly';

// surface_grid grid spec
const DD_MIN = 0.200;
const DD_MAX = 0.950;
const DD_STEP = 0.025;
const DUR_MIN = 0;
const DUR_MAX = 1800;
const DUR_STEP = 60;

// Anchor date for surface_grid synthetic paths. Validation paths anchor
// to each regime's own peak date; surface_grid cells have no regime, so a
// fixed reference peak date is used. ICO_2018 is the median of the three
// pool regime peaks and falls mid-month, so payment-day alignment around
// the synthetic peak is unremarkable.
const SURFACE_GRID_ANCHOR_PEAK_DATE_STR = '2017-12-16';

const SOLVER_MOMENT_TOL = 0.005;
const BISECTION_RANGE_MIN = 1.0;
const BISECTION_RANGE_MAX = 100.0;
const BISECTION_STEPS_PER_UNIT = 10; // 0.1 resolution
const VALIDATION_GATE_MAX_ABS_DELTA_BCR = 0.5;
const SYNTHETIC_PEAK_PRICE_USD = 100.0;

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256OfFile(filePath) {
    return sha256Hex(fs.readFileSync(filePath));
}

function addDays(d, n) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
}

function toIsoDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
}

function buildLocfDailyTrajectory(priceRows, peakDate, endDate) {
    // Build a calendar-complete daily trajectory from peakDate through endDate (inclusive)
    // using last-observation-carried-forward on priceRows (which are sparse for Bitstamp).
    // priceRows is sorted ascending; each has .date (Date) and .priceUsd.
    const out = [];
    let cursor = 0;
    // Advance cursor to the first row with date <= peakDate so we can LOCF onto missing days.
    let lastKnown = null;
    while (cursor < priceRows.length && priceRows[cursor].date <= peakDate) {
        lastKnown = priceRows[cursor].priceUsd;
        cursor++;
    }
    // cursor now points to first row.date > peakDate (or end).
    let day = new Date(peakDate.getTime());
    const dayCountTotal = Math.round((endDate - peakDate) / 86400000) + 1;
    for (let i = 0; i < dayCountTotal; i++) {
        // Advance lastKnown to the latest row whose date <= current day.
        while (cursor < priceRows.length && priceRows[cursor].date <= day) {
            lastKnown = priceRows[cursor].priceUsd;
            cursor++;
        }
        if (lastKnown == null) throw new Error('No prior price for LOCF at ' + toIsoDateStr(day));
        out.push({ date: new Date(day.getTime()), priceUsd: lastKnown });
        day = addDays(day, 1);
    }
    return out;
}

function computeRegimeTrajectories(priceSources) {
    // For each surface regime, slice peak through recovery (inclusive) and produce
    // a daily LOCF trajectory with drawdown_from_peak per row.
    const out = {};
    for (const rDef of REGIMES) {
        if (!SURFACE_REGIME_IDS.includes(rDef.id)) continue;
        const sourceKey = rDef.dataSource || 'bitstamp';
        const src = priceSources[sourceKey];
        if (!src) throw new Error('Unknown price source for regime ' + rDef.id + ': ' + sourceKey);
        const resolved = resolveRegimeDates(rDef);
        const peakIdx = statsMod.findPeakIndex(src.rows, resolved.peakSearchStartDate, resolved.peakSearchEndDate);
        const peakRow = src.rows[peakIdx];
        const peakDate = peakRow.date;
        const peakPrice = peakRow.priceUsd;

        // Build a LOCF-imputed daily trajectory from peakDate to peakDate + regimeLengthYears.
        const windowEndDate = new Date(peakDate.getFullYear() + rDef.regimeLengthYears, peakDate.getMonth(), peakDate.getDate());
        const dailyRows = buildLocfDailyTrajectory(src.rows, peakDate, windowEndDate);

        // Find first recovery: first day after a price-dip below peak where price >= peakPrice.
        let firstRecoveryIdx = -1;
        let sawDip = false;
        for (let i = 1; i < dailyRows.length; i++) {
            if (!sawDip) {
                if (dailyRows[i].priceUsd < peakPrice) sawDip = true;
            } else {
                if (dailyRows[i].priceUsd >= peakPrice) { firstRecoveryIdx = i; break; }
            }
        }
        const endIdx = firstRecoveryIdx >= 0 ? firstRecoveryIdx : dailyRows.length - 1;
        const trajectoryRows = dailyRows.slice(0, endIdx + 1);

        const drawdowns = trajectoryRows.map(r => 1 - r.priceUsd / peakPrice);

        out[rDef.id] = {
            regimeId: rDef.id,
            peakDate,
            peakPrice,
            recoveryIdx: firstRecoveryIdx,
            isCensored: firstRecoveryIdx < 0,
            rows: trajectoryRows.map((r, i) => ({
                date: toIsoDateStr(r.date),
                day_index: i,
                days_from_peak: Math.round((r.date - peakDate) / 86400000),
                price_usd: r.priceUsd,
                drawdown_from_peak: drawdowns[i],
            })),
            drawdowns,
        };
    }
    return out;
}

// Population std (ddof=0): divisor N, not N-1. The paper's σ is the
// population standard deviation of the depth-normalized drawdown trajectory.
function meanAndPopulationStd(values) {
    const n = values.length;
    if (n === 0) return { mean: 0, std: 0 };
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / n;
    let sq = 0;
    for (const v of values) { const d = v - mean; sq += d * d; }
    const variance = sq / n;
    return { mean, std: Math.sqrt(variance) };
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

// ---------------------------------------------------------------------------
// Synthetic family + (p, q) solver.
// ---------------------------------------------------------------------------

// Profile values: profile(t) = 1 - (1 - (4t(1-t))^p)^q in [0, 1].
// Depth-normalized moments (mean and population std of profile over t = 0..1
// in steps of 1/N) depend on (N, p, q) only; depth drops out of the
// moment computation. Synthesis at the cell scales profile by the cell's
// drawdown_fraction (depth).
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
    const prof = buildSyntheticProfileArray(N, p, q);
    return prof.map(v => depth * v);
}

// Inner bisection: given N, p, find q so that mean(profile) = tauNormTarget.
// Profile mean is monotonically increasing in q for any fixed p (increasing q
// pushes profile toward 1 uniformly). Returns q or null if the target is
// outside the achievable profile-mean range for this p.
function solveQforTau(N, p, tauNormTarget, maxIter = 80) {
    let qLo = 1e-4;
    let qHi = 1e4;
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

// Outer bisection over p (log space). With tau pinned via q, profile-sigma is
// monotonic in p over the family's useful range: small p produces a wide,
// flat-topped profile (low sigma), large p produces a sharp central spike
// (high sigma). Achievable tau range shrinks at very large p, so we first
// do a coarse log-p sweep to find a bracket where sigma straddles the
// target, then bisect inside that bracket. Solver is depth-independent;
// the same (p, q) applies at every depth for a given N and (tau, sigma).
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
        if (s == null) {
            pHi = pMid;
            continue;
        }
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

// ---------------------------------------------------------------------------
// Engine wrapper: clears(startingBcr, syntheticPriceArray, syntheticDateArray)
// ---------------------------------------------------------------------------

function buildSyntheticPathAtAnchor(depth, N, p, q, anchorPeakDate, peakPriceUsd = SYNTHETIC_PEAK_PRICE_USD) {
    const drawdowns = buildSyntheticDrawdownArray(depth, N, p, q);
    const prices = drawdowns.map(dd => peakPriceUsd * (1 - dd));
    const dates = new Array(N + 1);
    for (let i = 0; i <= N; i++) dates[i] = addDays(anchorPeakDate, i);
    return { prices, dates, drawdowns };
}

function clearsPrimary(startingBcr, prices, dates) {
    const peakPrice = prices[0];
    const btc0 = BTC_RESERVE_INITIAL_USD / peakPrice;
    const annualObligationUsd = BTC_RESERVE_INITIAL_USD / startingBcr;
    const paymentObligationUsd = annualObligationUsd / 12;
    const res = engine.runSolvencyOnDailyPath(
        prices,
        dates,
        btc0,
        paymentObligationUsd,
        annualObligationUsd,
        ENGINE_CADENCE
    );
    return !res.failed;
}

function bisectLowestClearingBcr(prices, dates) {
    // BCR values discretized at 0.1: integer steps 10..1000 represent 1.0..100.0.
    const loInt = Math.round(BISECTION_RANGE_MIN * BISECTION_STEPS_PER_UNIT);
    const hiInt = Math.round(BISECTION_RANGE_MAX * BISECTION_STEPS_PER_UNIT);
    if (clearsPrimary(loInt / BISECTION_STEPS_PER_UNIT, prices, dates)) {
        return { status: 'ok', threshold: loInt / BISECTION_STEPS_PER_UNIT };
    }
    if (!clearsPrimary(hiInt / BISECTION_STEPS_PER_UNIT, prices, dates)) {
        return { status: 'no_solution_in_range', threshold: null };
    }
    let lo = loInt;
    let hi = hiInt;
    while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (clearsPrimary(mid / BISECTION_STEPS_PER_UNIT, prices, dates)) hi = mid;
        else lo = mid;
    }
    // hi is lowest integer step that clears.
    const threshold = hi / BISECTION_STEPS_PER_UNIT;
    if (Math.abs(threshold - BISECTION_RANGE_MAX) < 1e-9) {
        return { status: 'hit_ceiling', threshold: null };
    }
    return { status: 'ok', threshold };
}

// ---------------------------------------------------------------------------
// Main build.
// ---------------------------------------------------------------------------

function main() {
    const startMs = Date.now();
    console.log('===========================================================');
    console.log('Phase 2 -- Coverage Surface Construction');
    console.log('Run timestamp:', RUN_TIMESTAMP);
    console.log('Surface code version:', SURFACE_CODE_VERSION);
    console.log('Engine sha256:', engine.engineSha256);
    console.log('===========================================================');
    console.log();

    const priceSources = loadPriceSources();
    const trajectories = computeRegimeTrajectories(priceSources);

    // -------------------------------------------------------------------
    // 1. time_at_depth_distributions.csv
    // -------------------------------------------------------------------
    console.log('Building time_at_depth_distributions.csv ...');
    const tadCols = ['regime', 'date', 'day_index', 'days_from_peak', 'price_usd',
                     'drawdown_from_peak', 'is_in_pool'];
    const tadRows = [];
    for (const rid of SURFACE_REGIME_IDS) {
        const t = trajectories[rid];
        const inPool = POOL_REGIME_IDS.includes(rid);
        for (const r of t.rows) {
            tadRows.push({
                regime: rid,
                date: r.date,
                day_index: r.day_index,
                days_from_peak: r.days_from_peak,
                price_usd: r.price_usd,
                drawdown_from_peak: r.drawdown_from_peak,
                is_in_pool: inPool,
            });
        }
    }
    const tadRes = writeCsv(path.join(OUTPUT_DIR, 'time_at_depth_distributions.csv'), tadCols, tadRows);
    console.log('  rows: ' + tadRes.rowCount + ', sha256: ' + tadRes.sha256);
    console.log();

    // -------------------------------------------------------------------
    // 2. regime_tau_sigma.csv  +  pool_n3 row  (depth-normalized moments)
    // -------------------------------------------------------------------
    console.log('Computing per-regime depth-normalized (tau, sigma) moments ...');
    const perRegimeMoments = {};
    for (const rid of SURFACE_REGIME_IDS) {
        const drawdowns = trajectories[rid].drawdowns;
        let maxDd = 0;
        for (const v of drawdowns) if (v > maxDd) maxDd = v;
        if (maxDd <= 0) throw new Error('Non-positive max drawdown for regime ' + rid);
        const normalized = drawdowns.map(v => v / maxDd);
        const { mean, std } = meanAndPopulationStd(normalized);
        perRegimeMoments[rid] = {
            tau: mean,
            sigma: std,
            n: drawdowns.length,
            maxDd,
        };
        const inPool = POOL_REGIME_IDS.includes(rid);
        console.log('  ' + rid.padEnd(11) + '  tau=' + mean.toFixed(6) + '  sigma=' + std.toFixed(6)
            + '  n=' + drawdowns.length + '  max_dd=' + maxDd.toFixed(6) + '  in_pool=' + inPool);
    }
    const pooledTau = POOL_REGIME_IDS.reduce((s, rid) => s + perRegimeMoments[rid].tau, 0) / POOL_REGIME_IDS.length;
    const pooledSigma = POOL_REGIME_IDS.reduce((s, rid) => s + perRegimeMoments[rid].sigma, 0) / POOL_REGIME_IDS.length;
    console.log('  pool_n3      tau=' + pooledTau.toFixed(6) + '  sigma=' + pooledSigma.toFixed(6));
    console.log();

    const tauSigmaCols = ['regime', 'tau', 'sigma', 'n_days', 'in_pool'];
    const tauSigmaRows = [];
    for (const rid of SURFACE_REGIME_IDS) {
        const m = perRegimeMoments[rid];
        tauSigmaRows.push({
            regime: rid,
            tau: m.tau,
            sigma: m.sigma,
            n_days: m.n,
            in_pool: POOL_REGIME_IDS.includes(rid),
        });
    }
    tauSigmaRows.push({
        regime: 'pool_n3',
        tau: pooledTau,
        sigma: pooledSigma,
        n_days: '',
        in_pool: false,
    });
    const tauSigmaRes = writeCsv(path.join(OUTPUT_DIR, 'regime_tau_sigma.csv'), tauSigmaCols, tauSigmaRows);
    console.log('  regime_tau_sigma.csv rows: ' + tauSigmaRes.rowCount + ', sha256: ' + tauSigmaRes.sha256);
    console.log();

    // -------------------------------------------------------------------
    // 3. surface_validation.csv  (gate)
    // -------------------------------------------------------------------
    console.log('Running surface validation (4 regimes) ...');
    const descriptorsByRegime = {};
    const descriptorRaw = fs.readFileSync(path.join(OUTPUT_DIR, 'regime_descriptors.csv'), 'utf8');
    const descriptorLines = descriptorRaw.split(/\r?\n/).filter(l => l.length > 0);
    const descriptorHeader = parseCsvRow(descriptorLines[0]);
    for (let i = 1; i < descriptorLines.length; i++) {
        const cols = parseCsvRow(descriptorLines[i]);
        const obj = {};
        descriptorHeader.forEach((h, j) => obj[h] = cols[j]);
        descriptorsByRegime[obj.regime] = obj;
    }

    const validationCols = ['regime', 'drawdown_fraction', 'duration_days',
                            'historical_required_starting_bcr', 'synthetic_required_starting_bcr',
                            'delta_bcr', 'abs_delta_bcr', 'in_pool'];
    const validationRows = [];
    let maxAbsDelta = -Infinity;
    for (const rid of VALIDATION_REGIME_IDS) {
        const desc = descriptorsByRegime[rid];
        if (!desc) throw new Error('Descriptor missing for regime ' + rid);
        const depth = Number(desc.max_drawdown_from_peak);
        const duration = Number(desc.days_peak_to_recovery);
        const histThreshold = Number(desc.required_starting_bcr_hi);

        const pq = solvePQ(duration, pooledTau, pooledSigma);
        if (pq == null) {
            console.log('  ' + rid + ': solver_no_convergence at (depth=' + depth.toFixed(4)
                + ', dur=' + duration + ')');
            validationRows.push({
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
        // Anchor synthetic to this regime's peak date.
        const anchorPeakDate = parseIsoDate(desc.peak_date);
        const syn = buildSyntheticPathAtAnchor(depth, duration, pq.p, pq.q, anchorPeakDate);
        const result = bisectLowestClearingBcr(syn.prices, syn.dates);
        const synThreshold = result.threshold;
        // Both thresholds are quantized to the 0.1 BCR grid; compute delta
        // on the integer-tenths representation so floating-point noise does
        // not push 0.5 to 0.5000000000000004.
        const delta = synThreshold != null
            ? (Math.round(synThreshold * 10) - Math.round(histThreshold * 10)) / 10
            : null;
        const absDelta = delta != null ? Math.abs(delta) : null;
        if (absDelta != null && absDelta > maxAbsDelta) maxAbsDelta = absDelta;
        console.log('  ' + rid.padEnd(11) + '  depth=' + depth.toFixed(4)
            + '  dur=' + String(duration).padStart(4)
            + '  hist=' + histThreshold.toFixed(1).padStart(5)
            + '  syn=' + (synThreshold != null ? synThreshold.toFixed(1).padStart(5) : 'null ')
            + '  delta=' + (delta != null ? delta.toFixed(2).padStart(6) : 'null')
            + '  (p=' + pq.p.toFixed(4) + ', q=' + pq.q.toFixed(4)
            + ', tau=' + pq.tau.toFixed(4) + ', sigma=' + pq.sigma.toFixed(4)
            + ', status=' + result.status + ')');
        validationRows.push({
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
    const validationRes = writeCsv(path.join(OUTPUT_DIR, 'surface_validation.csv'), validationCols, validationRows);
    console.log('  max(|delta_bcr|) = ' + maxAbsDelta.toFixed(4));
    console.log('  gate = ' + (maxAbsDelta <= VALIDATION_GATE_MAX_ABS_DELTA_BCR ? 'PASS' : 'FAIL') + ' (<= ' + VALIDATION_GATE_MAX_ABS_DELTA_BCR + ')');
    console.log();

    if (!(maxAbsDelta <= VALIDATION_GATE_MAX_ABS_DELTA_BCR)) {
        console.error('VALIDATION GATE FAILED. Halting before writing surface_grid.csv.');
        console.error('Per-regime deltas:');
        for (const r of validationRows) {
            console.error('  ' + r.regime + '  delta=' + (r.delta_bcr != null ? r.delta_bcr.toFixed(2) : 'null'));
        }
        // Still update manifest? Spec says halt before writing surface_grid.csv beyond diagnostics.
        // We write the three non-grid CSVs and the validation, but skip surface_grid.csv.
        process.exitCode = 2;
        return;
    }

    // -------------------------------------------------------------------
    // 4. surface_grid.csv
    // -------------------------------------------------------------------
    console.log('Building surface_grid.csv ...');
    const ddValues = [];
    for (let v = DD_MIN; v <= DD_MAX + 1e-9; v += DD_STEP) ddValues.push(Math.round(v * 1000) / 1000);
    const durValues = [];
    for (let v = DUR_MIN; v <= DUR_MAX + 1e-9; v += DUR_STEP) durValues.push(Math.round(v));
    console.log('  grid: ' + ddValues.length + ' x ' + durValues.length + ' = ' + (ddValues.length * durValues.length) + ' cells');

    const surfaceCols = ['drawdown_fraction', 'duration_days',
                         'required_starting_bcr',
                         'required_starting_bcr_terminal',
                         'synthesis_status'];
    const surfaceRows = [];
    const anchorPeakDateGrid = parseIsoDate(SURFACE_GRID_ANCHOR_PEAK_DATE_STR);
    const flagged = [];
    let cellsDone = 0;
    const lastLogMs = { value: Date.now() };
    const pqCacheByDuration = new Map(); // depth-independent: cache (p, q) per duration

    for (const dd of ddValues) {
        for (const dur of durValues) {
            cellsDone++;
            let row;
            if (dur === 0) {
                row = {
                    drawdown_fraction: dd,
                    duration_days: dur,
                    required_starting_bcr: null,
                    required_starting_bcr_terminal: null,
                    synthesis_status: 'degenerate',
                };
                surfaceRows.push(row);
                continue;
            }
            // Solver depends only on (duration, target moments); cache by duration.
            let pq;
            if (pqCacheByDuration.has(dur)) {
                pq = pqCacheByDuration.get(dur);
            } else {
                pq = solvePQ(dur, pooledTau, pooledSigma);
                pqCacheByDuration.set(dur, pq);
            }
            if (pq == null) {
                row = {
                    drawdown_fraction: dd,
                    duration_days: dur,
                    required_starting_bcr: null,
                    required_starting_bcr_terminal: null,
                    synthesis_status: 'solver_no_convergence',
                };
                flagged.push({ dd, dur, status: 'solver_no_convergence' });
                surfaceRows.push(row);
                continue;
            }
            const syn = buildSyntheticPathAtAnchor(dd, dur, pq.p, pq.q, anchorPeakDateGrid);
            const res = bisectLowestClearingBcr(syn.prices, syn.dates);
            if (res.status === 'ok') {
                row = {
                    drawdown_fraction: dd,
                    duration_days: dur,
                    required_starting_bcr: res.threshold,
                    required_starting_bcr_terminal: null,
                    synthesis_status: 'ok',
                };
            } else {
                row = {
                    drawdown_fraction: dd,
                    duration_days: dur,
                    required_starting_bcr: null,
                    required_starting_bcr_terminal: null,
                    synthesis_status: res.status,
                };
                flagged.push({ dd, dur, status: res.status });
            }
            surfaceRows.push(row);

            const now = Date.now();
            if (now - lastLogMs.value > 10000) {
                console.log('  progress: ' + cellsDone + '/' + (ddValues.length * durValues.length)
                    + ' (' + ((cellsDone * 100) / (ddValues.length * durValues.length)).toFixed(1) + '%)');
                lastLogMs.value = now;
            }
        }
    }
    const surfaceRes = writeCsv(path.join(OUTPUT_DIR, 'surface_grid.csv'), surfaceCols, surfaceRows);
    console.log('  surface_grid.csv rows: ' + surfaceRes.rowCount + ', sha256: ' + surfaceRes.sha256);
    console.log('  flagged cells: ' + flagged.length);
    if (flagged.length > 0) {
        const byStatus = {};
        for (const f of flagged) {
            (byStatus[f.status] = byStatus[f.status] || []).push(f);
        }
        for (const status of Object.keys(byStatus)) {
            console.log('    ' + status + ': ' + byStatus[status].length + ' cells');
            for (const f of byStatus[status].slice(0, 10)) {
                console.log('      (depth=' + f.dd.toFixed(3) + ', dur=' + f.dur + ')');
            }
            if (byStatus[status].length > 10) console.log('      ... and ' + (byStatus[status].length - 10) + ' more');
        }
    }
    console.log();

    // -------------------------------------------------------------------
    // 5. manifest.json phase_2 block
    // -------------------------------------------------------------------
    console.log('Updating manifest.json ...');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    // Merge: do not touch top-level code_version or reproducibility.code_version;
    // those belong to export.js's release tag. Surface build identifies itself
    // inside the phase_2 block only.

    manifest.phase_2 = {
        surface_code_version: SURFACE_CODE_VERSION,
        engine_sha256: engine.engineSha256,
        sweep_grid: {
            drawdown_fraction_min: DD_MIN,
            drawdown_fraction_max: DD_MAX,
            drawdown_fraction_step: DD_STEP,
            duration_days_min: DUR_MIN,
            duration_days_max: DUR_MAX,
            duration_days_step: DUR_STEP,
            total_cells: surfaceRows.length,
        },
        pool: {
            composition: POOL_REGIME_IDS,
            weighting: 'unweighted_mean',
            pooled_tau: pooledTau,
            pooled_sigma: pooledSigma,
            moment_normalization: 'depth_normalized',
            moment_definition: 'tau and sigma are mean and population standard deviation (denominator N, ddof=0) of drawdown_from_peak / max_drawdown_from_peak over the regime window (peak to recovery)',
        },
        per_regime_moments: SURFACE_REGIME_IDS.map(rid => ({
            regime: rid,
            tau: perRegimeMoments[rid].tau,
            sigma: perRegimeMoments[rid].sigma,
            max_drawdown_from_peak: perRegimeMoments[rid].maxDd,
            n_days: perRegimeMoments[rid].n,
            in_pool: POOL_REGIME_IDS.includes(rid),
        })),
        synthetic_family: 'symmetric_two_parameter',
        anchor_convention: 'peak_date',
        surface_grid_anchor_peak_date: SURFACE_GRID_ANCHOR_PEAK_DATE_STR,
        surface_grid_anchor_note: 'Validation paths anchor to each regime\'s own peak date. The surface_grid cells have no regime; a single reference peak date is used so payment-day cadence is deterministic across cells. ICO_2018 is the median of the three pool regime peaks and falls mid-month.',
        depth_normalization: 'drawdown_fraction_from_peak',
        time_weighting: 'uniform',
        solver_moment_tolerance: SOLVER_MOMENT_TOL,
        bisection_range: [BISECTION_RANGE_MIN, BISECTION_RANGE_MAX],
        bisection_resolution: 1 / BISECTION_STEPS_PER_UNIT,
        validation_gate_max_abs_delta_bcr: VALIDATION_GATE_MAX_ABS_DELTA_BCR,
        validation_gate_status: maxAbsDelta <= VALIDATION_GATE_MAX_ABS_DELTA_BCR ? 'pass' : 'fail',
        validation_gate_observed_max_abs_delta_bcr: maxAbsDelta,
        out_of_pool_validation_regime: 'apr_2013',
        early_2011_status: 'excluded_pending_mapping',
        build_history: {
            moment_normalization_lock: 'depth_normalized',
            lock_rationale: 'tau and sigma are shape descriptors; depth must factor out at measurement time so the symmetric two-parameter family can synthesize coherent paths across the full surface (drawdown_fraction in [0.200, 0.950]). Raw moments are mechanically incoherent below their own value and were not the locked convention.',
            prior_build_note: 'An interim build computed raw drawdown moments and was discarded before Phase 2 lock. The published artifacts in this manifest are the depth-normalized build only.',
        },
        flagged_cells: flagged,
        sha256: {
            time_at_depth_distributions: tadRes.sha256,
            regime_tau_sigma: tauSigmaRes.sha256,
            surface_grid: surfaceRes.sha256,
            surface_validation: validationRes.sha256,
        },
        run_timestamp: RUN_TIMESTAMP,
    };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('  manifest.json updated');
    console.log();

    const elapsedMs = Date.now() - startMs;
    console.log('===========================================================');
    console.log('Done. Elapsed: ' + (elapsedMs / 1000).toFixed(1) + ' s');
    console.log('===========================================================');
}

function parseCsvRow(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
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

if (require.main === module) {
    main();
}
