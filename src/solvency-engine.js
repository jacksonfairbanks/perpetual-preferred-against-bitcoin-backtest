/**
 * BCR Backtest Engine
 *
 * Computes Bitcoin Coverage Ratio (BCR) paths over historical price data.
 * BCR = BTC reserve value / annual dividend obligation. See paper §3.
 *
 * No ES6 modules — functions are declared at top-level scope and extracted
 * by scripts/lib/engine.js via a Function()-based loader.
 *
 * Failure terminology, mirroring the paper:
 *   - "Primary failure" = first day BCR < 1x (paper §4.1).
 *   - "Terminal liquidity" = first day BTC value < next monthly payment;
 *     evaluated externally on a parallel mechanical continuation in
 *     scripts/lib/runner.js, not in this engine. Paper §4.2.
 */

/**
 * True if the given date is the last calendar day of its month.
 * @param {Date} d
 * @returns {boolean}
 */
function isLastDayOfMonth(d) {
    const date = d instanceof Date ? d : new Date(d);
    const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return date.getDate() === lastDayOfMonth;
}

/**
 * Run the BCR backtest on a daily price path with payments on a configurable cadence.
 * Returns daily bcrPath and btcReservePath so BCR visibly lags price (step-down on payment days).
 *
 * Cadence:
 *   'monthly' (default) - payment fires once per month on the last calendar day of the month;
 *                         paymentObligation is the per-month amount (annual / 12).
 *   'daily'             - payment fires every day at the daily close;
 *                         paymentObligation is the per-day amount (annual / 365).
 *
 * Payment execution: every dividend obligation is funded from BTC sales at the
 * day's close price. Paper §5.1 stripped pure-play model — no cash reserve,
 * no OPEX, no capital markets access.
 *
 * @param {number[]} dailyPrices - one price per day
 * @param {Date[]} dailyDates - one date per day (same length as dailyPrices)
 * @param {number} btcStart - initial BTC holdings
 * @param {number} paymentObligation - per-payment amount (annual/12 if cadence='monthly', annual/365 if 'daily')
 * @param {number} annualObligation - annual dividend obligation in same units as the BTC reserve value (used to compute BCR)
 * @param {string} [cadence='monthly'] - 'monthly' or 'daily'
 *
 * Returns { terminalBCR, terminalBtcReserve, minBCR, failed, earliestPrimaryFailureDay,
 *           bcrPath, btcReservePath, btcHoldPath }.
 * earliestPrimaryFailureDay marks the first day BCR < 1x (paper §4.1).
 */
function runSolvencyOnDailyPath(dailyPrices, dailyDates, btcStart, paymentObligation, annualObligation, cadence) {
    if (!dailyPrices || dailyPrices.length === 0 || !dailyDates || dailyDates.length !== dailyPrices.length) {
        throw new Error('Daily price and date arrays must be non-empty and same length');
    }
    if (btcStart < 0 || paymentObligation < 0 || annualObligation < 0) throw new Error('Invalid inputs');
    if (cadence === undefined || cadence === null) cadence = 'monthly';
    if (cadence !== 'monthly' && cadence !== 'daily') throw new Error("cadence must be 'monthly' or 'daily'");

    let btcHold = btcStart;
    const btcReservePath = [];
    const bcrPath = [];
    const btcHoldPath = [];
    let failed = false;
    let earliestPrimaryFailureDay = null;
    let minBCR = Infinity;
    let lastPaymentMonthKey = -1;

    for (let i = 0; i < dailyPrices.length; i++) {
        const price = dailyPrices[i];
        const date = dailyDates[i] instanceof Date ? dailyDates[i] : new Date(dailyDates[i]);
        const monthKey = date.getFullYear() * 12 + date.getMonth();

        if (!failed) {
            const isPaymentDay = cadence === 'daily'
                ? true
                : (isLastDayOfMonth(date) && monthKey !== lastPaymentMonthKey);
            if (isPaymentDay && paymentObligation > 0) {
                if (cadence !== 'daily') lastPaymentMonthKey = monthKey;
                if (price > 0) {
                    const btcToSell = Math.min(btcHold, paymentObligation / price);
                    btcHold -= btcToSell;
                    if (btcHold < 0) btcHold = 0;
                }
            }

            const btcReserve = btcHold * price;
            const bcr = annualObligation > 0 ? btcReserve / annualObligation : 0;
            btcReservePath.push(btcReserve);
            bcrPath.push(bcr);
            btcHoldPath.push(btcHold);
            if (bcr < minBCR) minBCR = bcr;

            if (btcHold <= 0 || bcr < 1.0) {
                failed = true;
                earliestPrimaryFailureDay = i;
            }
        } else {
            btcReservePath.push(btcReservePath[btcReservePath.length - 1]);
            bcrPath.push(bcrPath[bcrPath.length - 1]);
            btcHoldPath.push(btcHoldPath[btcHoldPath.length - 1]);
        }
    }

    return {
        terminalBCR: bcrPath[bcrPath.length - 1],
        terminalBtcReserve: btcReservePath[btcReservePath.length - 1],
        minBCR: minBCR === Infinity ? 0 : minBCR,
        failed,
        earliestPrimaryFailureDay,
        bcrPath,
        btcReservePath,
        btcHoldPath
    };
}
