const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BITSTAMP_CSV_PATH    = path.resolve(__dirname, '..', '..', 'data', 'btc-prices-bitstamp.csv');
const COINMETRICS_CSV_PATH = path.resolve(__dirname, '..', '..', 'data', 'btc-prices-coinmetrics.csv');

function parseIsoDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) throw new Error('Bad date: ' + JSON.stringify(s));
    const y = +m[1], mo = +m[2], d = +m[3];
    return new Date(y, mo - 1, d);
}

function loadCsvTwoCol(csvPath, expectedHeader) {
    const raw = fs.readFileSync(csvPath, 'utf8');
    const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    const header = lines[0].toLowerCase().replace(/\s+/g, '');
    if (!expectedHeader.some(h => header.startsWith(h))) {
        throw new Error('Unexpected CSV header in ' + csvPath + ': ' + lines[0]);
    }
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 2) throw new Error('Malformed row at line ' + (i + 1) + ': ' + lines[i]);
        const date = parseIsoDate(parts[0]);
        const priceUsd = Number(parts[1]);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error('Bad price at line ' + (i + 1) + ': ' + lines[i]);
        rows.push({ date, priceUsd, dateStr: parts[0].trim() });
    }
    for (let i = 1; i < rows.length; i++) {
        if (rows[i].date <= rows[i - 1].date) {
            throw new Error('Dates not strictly ascending at ' + rows[i].dateStr);
        }
    }
    return {
        rows,
        meta: {
            path: path.relative(path.resolve(__dirname, '..', '..'), csvPath).split(path.sep).join('/'),
            sha256,
            rowCount: rows.length,
            dateRange: [rows[0].dateStr, rows[rows.length - 1].dateStr],
            byteLength: Buffer.byteLength(raw, 'utf8'),
        },
    };
}

function loadPrices() {
    return loadCsvTwoCol(BITSTAMP_CSV_PATH, ['date,price']);
}

function loadCoinmetrics2011() {
    return loadCsvTwoCol(COINMETRICS_CSV_PATH, ['date,price']);
}

function loadPriceSources() {
    const bitstamp = loadPrices();
    const coinmetrics2011 = loadCoinmetrics2011();
    return {
        bitstamp: { rows: bitstamp.rows, meta: { ...bitstamp.meta, source: 'bitstamp' } },
        coinmetrics_2011: { rows: coinmetrics2011.rows, meta: { ...coinmetrics2011.meta, source: 'coinmetrics' } },
    };
}

function sliceInclusive(rows, startDate, endDate) {
    const out = [];
    for (const r of rows) {
        if (r.date >= startDate && r.date <= endDate) out.push(r);
    }
    return out;
}

module.exports = { loadPrices, loadCoinmetrics2011, loadPriceSources, sliceInclusive, parseIsoDate };
