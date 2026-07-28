function findPeakIndex(rows, startDate, endDate) {
    let best = -1;
    let bestPrice = -Infinity;
    for (let i = 0; i < rows.length; i++) {
        const d = rows[i].date;
        if (d < startDate || d > endDate) continue;
        if (rows[i].priceUsd > bestPrice) {
            bestPrice = rows[i].priceUsd;
            best = i;
        }
    }
    if (best < 0) throw new Error('Peak not found in search window');
    return best;
}

function findIndexByDate(rows, targetDate) {
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].date < targetDate) lo = mid + 1;
        else if (rows[mid].date > targetDate) hi = mid - 1;
        else return mid;
    }
    return lo;
}

function sliceByWindow(rows, peakIdx, windowEndDate) {
    const endIdx = findIndexByDate(rows, windowEndDate);
    const lastInclusive = Math.min(endIdx, rows.length - 1);
    const upper = rows[lastInclusive].date > windowEndDate ? lastInclusive - 1 : lastInclusive;
    return rows.slice(peakIdx, upper + 1);
}

function findTroughIndex(regimeRows) {
    let best = 0;
    let bestPrice = Infinity;
    for (let i = 0; i < regimeRows.length; i++) {
        if (regimeRows[i].priceUsd < bestPrice) {
            bestPrice = regimeRows[i].priceUsd;
            best = i;
        }
    }
    return best;
}

function findFirstRecoveryIndex(regimeRows, peakPrice) {
    for (let i = 1; i < regimeRows.length; i++) {
        if (regimeRows[i].priceUsd >= peakPrice) return i;
    }
    return -1;
}

function argminFrom(arr, start, end) {
    let best = start;
    let bestVal = Infinity;
    for (let i = start; i <= end; i++) {
        if (arr[i] < bestVal) { bestVal = arr[i]; best = i; }
    }
    return best;
}

function rollingRealizedVolLog(prices, window, annualizer) {
    const n = prices.length;
    const logRet = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
        if (prices[i - 1] > 0 && prices[i] > 0) {
            logRet[i] = Math.log(prices[i] / prices[i - 1]);
        }
    }
    const out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
        const start = i - window + 1;
        if (start < 1) continue;
        let sum = 0, count = 0;
        for (let j = start; j <= i; j++) {
            if (logRet[j] != null) { sum += logRet[j]; count++; }
        }
        if (count < 2) continue;
        const mean = sum / count;
        let sq = 0;
        for (let j = start; j <= i; j++) {
            if (logRet[j] != null) { const d = logRet[j] - mean; sq += d * d; }
        }
        const variance = sq / (count - 1);
        out[i] = Math.sqrt(variance) * Math.sqrt(annualizer);
    }
    return out;
}

function calendarDaysBetween(d1, d2) {
    const ms = d2.getTime() - d1.getTime();
    return Math.round(ms / 86400000);
}

function arithmeticDailyReturn(prices) {
    const n = prices.length;
    const out = new Array(n).fill(null);
    for (let i = 1; i < n; i++) {
        if (prices[i - 1] > 0) out[i] = prices[i] / prices[i - 1] - 1;
    }
    return out;
}

module.exports = {
    findPeakIndex,
    findIndexByDate,
    sliceByWindow,
    findTroughIndex,
    findFirstRecoveryIndex,
    argminFrom,
    rollingRealizedVolLog,
    arithmeticDailyReturn,
    calendarDaysBetween,
};
