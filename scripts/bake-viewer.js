// Rebuild the DATA_RAW literal in bcr_3d_viewer.html from the canonical
// outputs/surface_grid.csv + outputs/regime_descriptors.csv.
//
// Byte-deterministic given identical inputs: running twice on unchanged inputs
// produces a byte-identical HTML file. verify.sh hashes the viewer; this script
// is the regeneration path. Only the DATA_RAW = {...}; literal is rewritten;
// the rest of the HTML is untouched.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SURFACE_GRID = path.join(REPO_ROOT, 'outputs', 'surface_grid.csv');
const REGIME_DESCRIPTORS = path.join(REPO_ROOT, 'outputs', 'regime_descriptors.csv');
const VIEWER_HTML = path.join(REPO_ROOT, 'bcr_3d_viewer.html');

const ANCHOR_REGIMES = ['apr_2013', 'mtgox_2014', 'ico_2018', 'fed_2022'];

function parseCsv(text) {
    const lines = text.split('\n').filter(l => l.length > 0);
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
        const cells = splitCsvLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = cells[i]; });
        return row;
    });
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { cur += c; }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ',') { out.push(cur); cur = ''; }
            else { cur += c; }
        }
    }
    out.push(cur);
    return out;
}

function uniqSorted(arr) {
    return [...new Set(arr)].sort((a, b) => a - b);
}

// ---------- Number formatters (chosen to reproduce the published literal byte-for-byte) ----------

// Depths in percent: 1-decimal fixed. 20 -> "20.0", 22.5 -> "22.5".
function fmtDepthPct(x) {
    return x.toFixed(1);
}

// Durations in months: round to 3 decimals, then JS-default string (drops trailing zeros).
// Integer-valued (e.g. 0) gets ".0" appended. 0 -> "0.0", 1.971 -> "1.971", 15.77 -> "15.77".
function fmtDurationMo(x) {
    const r = Math.round(x * 1000) / 1000;
    if (Number.isInteger(r)) return r.toFixed(1);
    return String(r);
}

// Grid Z (BCR): 1-decimal fixed, or null. CSV already at 0.1 resolution.
function fmtZ(x) {
    if (x === null) return 'null';
    return x.toFixed(1);
}

// Anchor depth and duration_mo: JS-default full-precision String(Number).
// Reproduces e.g. "0.7103056768558952" and "6.899383983572895".
function fmtFull(x) {
    return String(x);
}

// Anchor BCR: 1-decimal fixed. 4 -> "4.0", 10.5 -> "10.5".
function fmtBcr(x) {
    return x.toFixed(1);
}

// ---------- Build the literal ----------

function buildLiteral() {
    const surfaceText = fs.readFileSync(SURFACE_GRID, 'utf8');
    const surfaceRows = parseCsv(surfaceText);

    const depths = uniqSorted(surfaceRows.map(r => Number(r.drawdown_fraction)));
    const durations = uniqSorted(surfaceRows.map(r => Number(r.duration_days)));

    const depthIdx = new Map(depths.map((d, i) => [d, i]));
    const durationIdx = new Map(durations.map((d, i) => [d, i]));

    const z = depths.map(() => durations.map(() => null));
    for (const r of surfaceRows) {
        const i = depthIdx.get(Number(r.drawdown_fraction));
        const j = durationIdx.get(Number(r.duration_days));
        if (r.synthesis_status === 'ok' && r.required_starting_bcr !== '') {
            z[i][j] = Number(r.required_starting_bcr);
        }
    }

    const descriptorText = fs.readFileSync(REGIME_DESCRIPTORS, 'utf8');
    const descriptorRows = parseCsv(descriptorText);
    const anchors = ANCHOR_REGIMES.map(name => {
        const row = descriptorRows.find(r => r.regime === name);
        if (!row) throw new Error('regime not found in regime_descriptors.csv: ' + name);
        const days = Number(row.days_peak_to_recovery);
        return {
            regime: name,
            depth: Number(row.max_drawdown_from_peak),
            duration_mo: days * 12 / 365.25,
            duration_days: days,
            bcr: Number(row.required_starting_bcr_hi)
        };
    });

    const depthsStr = depths.map(d => fmtDepthPct(d * 100)).join(',');
    const durationsStr = durations.map(d => fmtDurationMo(d * 12 / 365.25)).join(',');
    const zStr = z.map(row => '[' + row.map(fmtZ).join(',') + ']').join(',');
    const anchorsStr = anchors.map(a =>
        '{"regime":' + JSON.stringify(a.regime) +
        ',"depth":' + fmtFull(a.depth) +
        ',"duration_mo":' + fmtFull(a.duration_mo) +
        ',"duration_days":' + String(a.duration_days) +
        ',"bcr":' + fmtBcr(a.bcr) + '}'
    ).join(',');

    return '{"depths_pct":[' + depthsStr + ']' +
        ',"durations_mo":[' + durationsStr + ']' +
        ',"z":[' + zStr + ']' +
        ',"anchors":[' + anchorsStr + ']}';
}

// ---------- Splice into the HTML ----------

function bake() {
    const literal = buildLiteral();
    const html = fs.readFileSync(VIEWER_HTML, 'utf8');
    const marker = 'const DATA_RAW = ';
    const start = html.indexOf(marker);
    if (start < 0) throw new Error('marker not found: ' + marker);
    const jsonStart = start + marker.length;
    // The literal ends with ]}; — find the first `};` after the marker and
    // splice between the literal's closing `}` and the trailing `;`.
    const term = html.indexOf('};', jsonStart);
    if (term < 0) throw new Error('terminator `};` not found after marker');
    const end = term + 1; // keep the `;` and everything after
    const newHtml = html.slice(0, jsonStart) + literal + html.slice(end);
    fs.writeFileSync(VIEWER_HTML, newHtml);

    const crypto = require('crypto');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(VIEWER_HTML)).digest('hex');
    const size = fs.statSync(VIEWER_HTML).size;
    console.log('Wrote ' + VIEWER_HTML);
    console.log('  bytes:  ' + size);
    console.log('  sha256: ' + sha);
    console.log('verify.sh line:');
    console.log('  check ' + sha + ' bcr_3d_viewer.html');
}

bake();
