const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IN_PATH = path.resolve(__dirname, '..', 'data', 'raw', 'bitstamp_btc_prices.csv');
const OUT_PATH = path.resolve(__dirname, '..', 'data', 'btc-prices-bitstamp.csv');
const IMPUTATION_PATH = path.resolve(__dirname, '..', 'data', 'btc-prices-bitstamp-imputation.json');

function parseUsDate(s) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
    if (!m) throw new Error('Bad date: ' + JSON.stringify(s));
    const mo = +m[1], d = +m[2], y = +m[3];
    const pad = (n) => String(n).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)}`;
}

function toIsoLocal(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function main() {
    const raw = fs.readFileSync(IN_PATH, 'utf8');
    const sha256In = crypto.createHash('sha256').update(raw).digest('hex');
    const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const closeIdx = header.indexOf('close');
    const timeIdx = header.indexOf('time');
    if (timeIdx < 0 || closeIdx < 0) throw new Error('Unexpected header: ' + lines[0]);

    const observed = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(',');
        if (cells.length <= Math.max(timeIdx, closeIdx)) continue;
        const dateStr = parseUsDate(cells[timeIdx]);
        const price = Number(cells[closeIdx]);
        if (!Number.isFinite(price) || price <= 0) throw new Error('Bad close at line ' + (i + 1) + ': ' + lines[i]);
        observed.push({ dateStr, price });
    }
    observed.sort((a, b) => a.dateStr.localeCompare(b.dateStr));

    const observedMap = new Map();
    for (const r of observed) {
        if (observedMap.has(r.dateStr)) throw new Error('Duplicate date: ' + r.dateStr);
        observedMap.set(r.dateStr, r.price);
    }

    const firstDateStr = observed[0].dateStr;
    const lastDateStr  = observed[observed.length - 1].dateStr;
    const [fy, fm, fd] = firstDateStr.split('-').map(Number);
    const [ly, lm, ld] = lastDateStr.split('-').map(Number);
    const startDate = new Date(fy, fm - 1, fd);
    const endDate   = new Date(ly, lm - 1, ld);

    const contiguous = [];
    const imputedDates = [];
    let lastPrice = null;
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const ds = toIsoLocal(d);
        if (observedMap.has(ds)) {
            lastPrice = observedMap.get(ds);
            contiguous.push({ dateStr: ds, price: lastPrice, imputed: false });
        } else {
            if (lastPrice == null) throw new Error('Cannot impute before first observation: ' + ds);
            contiguous.push({ dateStr: ds, price: lastPrice, imputed: true });
            imputedDates.push(ds);
        }
    }

    const buf = ['date,price'];
    for (const r of contiguous) buf.push(`${r.dateStr},${r.price}`);
    const out = buf.join('\n') + '\n';
    fs.writeFileSync(OUT_PATH, out, 'utf8');
    const sha256Out = crypto.createHash('sha256').update(out).digest('hex');

    const imputation = {
        method: 'last_observation_carried_forward',
        rationale: 'Bitstamp has calendar-day gaps (primarily in 2011-2012 during the exchange\'s early trading period). Forward-fill uses the most recent prior observation so the monthly dividend payment schedule executes on every calendar month-end, not only those month-ends that happened to be trading days. Without LOCF, some payment days would be silently skipped, understating dividend stress for early regimes.',
        source_observations: observed.length,
        contiguous_days: contiguous.length,
        imputed_count: imputedDates.length,
        imputed_pct: imputedDates.length / contiguous.length,
        imputed_month_ends: imputedDates.filter(d => {
            const [y, mo, dd] = d.split('-').map(Number);
            return dd === new Date(y, mo, 0).getDate();
        }),
        imputed_dates: imputedDates,
        source_file: 'bitstamp_btc_prices.csv',
        source_sha256: sha256In,
        output_file: path.basename(OUT_PATH),
        output_sha256: sha256Out,
        date_range: [contiguous[0].dateStr, contiguous[contiguous.length - 1].dateStr],
    };
    fs.writeFileSync(IMPUTATION_PATH, JSON.stringify(imputation, null, 2) + '\n', 'utf8');

    console.log('Input:  ' + IN_PATH);
    console.log('  sha256:          ' + sha256In);
    console.log('  rows read:       ' + observed.length);
    console.log('Output: ' + OUT_PATH);
    console.log('  sha256:          ' + sha256Out);
    console.log('  contiguous rows: ' + contiguous.length);
    console.log('  range:           ' + imputation.date_range[0] + ' -> ' + imputation.date_range[1]);
    console.log('  imputed (LOCF):  ' + imputedDates.length + ' / ' + contiguous.length + ' (' + (imputation.imputed_pct * 100).toFixed(2) + '%)');
    console.log('  imputed month-ends: ' + imputation.imputed_month_ends.length);
    if (imputation.imputed_month_ends.length) console.log('    ' + imputation.imputed_month_ends.join(', '));
    console.log('Imputation log: ' + IMPUTATION_PATH);
}

if (require.main === module) main();
