const engine = require('./engine');
const stats = require('./stats');

const BTC_RESERVE_INITIAL_USD = 1_000_000_000;
const DIV_RATE = 0.10;

function mechanicalContinuation(dailyPrices, dailyDates, btcStart, paymentObligation, cadence) {
    const n = dailyPrices.length;
    const btcHoldPath = new Array(n);
    const btcSoldTodayPath = new Array(n);
    let btcHold = btcStart;
    let lastPaymentMonthKey = -1;
    let terminalLiquidityDay = -1;

    for (let i = 0; i < n; i++) {
        const price = dailyPrices[i];
        const date = dailyDates[i] instanceof Date ? dailyDates[i] : new Date(dailyDates[i]);
        const monthKey = date.getFullYear() * 12 + date.getMonth();
        let soldThisDay = 0;

        const btcValueUsd = btcHold * price;
        if (terminalLiquidityDay < 0 && (btcHold <= 1e-12 || btcValueUsd < paymentObligation)) {
            terminalLiquidityDay = i;
        }

        const isPaymentDay = cadence === 'daily'
            ? true
            : (engine.isLastDayOfMonth(date) && monthKey !== lastPaymentMonthKey);
        if (isPaymentDay && paymentObligation > 0) {
            if (cadence !== 'daily') lastPaymentMonthKey = monthKey;
            if (btcHold > 0 && price > 0) {
                const btcToSell = Math.min(btcHold, paymentObligation / price);
                btcHold -= btcToSell;
                soldThisDay = btcToSell;
                if (btcHold < 0) btcHold = 0;
            }
        }

        btcHoldPath[i] = btcHold;
        btcSoldTodayPath[i] = soldThisDay;
    }
    return { btcHoldPath, btcSoldTodayPath, terminalLiquidityDay };
}

function buildRegimeStrip(regimeRows, peakRowIndexInFull, regimeRowsFullWindow) {
    const n = regimeRows.length;
    const peakPrice = regimeRows[0].priceUsd;

    let regimePriceRecoveryIdx = -1;
    let sawPriceDip = false;
    for (let i = 1; i < regimeRowsFullWindow.length; i++) {
        if (!sawPriceDip) {
            if (regimeRowsFullWindow[i].priceUsd < peakPrice) sawPriceDip = true;
        } else {
            if (regimeRowsFullWindow[i].priceUsd >= peakPrice) { regimePriceRecoveryIdx = i; break; }
        }
    }
    const pctileWindowEnd = regimePriceRecoveryIdx >= 0 ? regimePriceRecoveryIdx : regimeRowsFullWindow.length - 1;
    let regimeTroughPrice = Infinity;
    for (let i = 0; i <= pctileWindowEnd; i++) {
        if (regimeRowsFullWindow[i].priceUsd < regimeTroughPrice) regimeTroughPrice = regimeRowsFullWindow[i].priceUsd;
    }
    const denomForPctile = peakPrice - regimeTroughPrice;

    const prices = regimeRows.map(r => r.priceUsd);
    const dailyReturn = stats.arithmeticDailyReturn(prices);
    const realizedVol30 = stats.rollingRealizedVolLog(prices, 30, 365);

    let runningMinNormalized = 1.0;
    let runningMaxDrawdown = 0.0;

    const peakDate = regimeRows[0].date;
    const strip = new Array(n);
    for (let i = 0; i < n; i++) {
        const r = regimeRows[i];
        const priceNormalized = r.priceUsd / peakPrice;
        const calendarDaysFromPeak = stats.calendarDaysBetween(peakDate, r.date);
        const drawdownFromPeak = 1 - priceNormalized;
        if (priceNormalized < runningMinNormalized) runningMinNormalized = priceNormalized;
        if (drawdownFromPeak > runningMaxDrawdown) runningMaxDrawdown = drawdownFromPeak;

        let pctile = denomForPctile > 0
            ? (r.priceUsd - regimeTroughPrice) / denomForPctile
            : 0.5;
        if (pctile < 0) pctile = 0;
        if (pctile > 1) pctile = 1;

        strip[i] = {
            date: r.dateStr,
            day_index: i,
            days_from_peak: calendarDaysFromPeak,
            is_last_day_of_month: engine.isLastDayOfMonth(r.date),
            price_usd: r.priceUsd,
            price_normalized: priceNormalized,
            drawdown_from_peak: drawdownFromPeak,
            running_min_price_normalized: runningMinNormalized,
            running_max_drawdown: runningMaxDrawdown,
            daily_return: dailyReturn[i],
            realized_vol_30d: realizedVol30[i],
            btc_price_regime_pctile: pctile,
        };
    }
    return {
        strip,
        prices,
        dates: regimeRows.map(r => r.date),
        peakPrice,
        regimeTroughPrice,
        regimePriceRecoveryIdx,
    };
}

function runScenario(regimeId, startingBcr, regimeStrip, regimeDates, regimePrices, cadence) {
    if (cadence === undefined || cadence === null) cadence = 'monthly';
    if (cadence !== 'monthly' && cadence !== 'daily') throw new Error("cadence must be 'monthly' or 'daily'");
    const peakPrice = regimeStrip[0].price_usd;
    const btc0 = BTC_RESERVE_INITIAL_USD / peakPrice;
    const annualObligationUsd = BTC_RESERVE_INITIAL_USD / startingBcr;
    const monthlyObligationUsd = annualObligationUsd / 12;
    const paymentObligationUsd = cadence === 'daily'
        ? annualObligationUsd / 365
        : monthlyObligationUsd;

    const res = engine.runSolvencyOnDailyPath(
        regimePrices,
        regimeDates,
        btc0,
        paymentObligationUsd,
        annualObligationUsd,
        cadence
    );

    const n = regimePrices.length;
    const { bcrPath, btcReservePath, btcHoldPath, earliestPrimaryFailureDay } = res;

    let recoveryDay = -1;
    let sawDrawdown = false;
    for (let i = 0; i < n; i++) {
        if (!sawDrawdown) {
            if (btcReservePath[i] < BTC_RESERVE_INITIAL_USD) sawDrawdown = true;
        } else {
            if (btcReservePath[i] >= BTC_RESERVE_INITIAL_USD) { recoveryDay = i; break; }
        }
    }

    let endIdx;
    if (recoveryDay >= 0) endIdx = recoveryDay;
    else endIdx = n - 1;

    const rawFailureDay = (earliestPrimaryFailureDay != null) ? earliestPrimaryFailureDay : -1;
    const primaryFailureDay = (rawFailureDay >= 0 && rawFailureDay <= endIdx) ? rawFailureDay : -1;

    let bcrMinDay = 0;
    let bcrMinVal = Infinity;
    for (let i = 0; i <= endIdx; i++) {
        if (bcrPath[i] < bcrMinVal) { bcrMinVal = bcrPath[i]; bcrMinDay = i; }
    }

    let troughDay = 0;
    let troughVal = Infinity;
    for (let i = 0; i <= endIdx; i++) {
        if (regimePrices[i] < troughVal) { troughVal = regimePrices[i]; troughDay = i; }
    }

    const mech = mechanicalContinuation(regimePrices, regimeDates, btc0, paymentObligationUsd, cadence);
    const mechInScope = (mech.terminalLiquidityDay >= 0 && mech.terminalLiquidityDay <= endIdx)
        ? mech.terminalLiquidityDay
        : -1;
    const terminalLiquidityDay = mechInScope;

    const daysFromPeakAt = (idx) => (idx >= 0 && idx < regimeStrip.length) ? regimeStrip[idx].days_from_peak : null;
    const calBcrMin = daysFromPeakAt(bcrMinDay);
    const calTrough = daysFromPeakAt(troughDay);
    const calRecovery = recoveryDay >= 0 ? daysFromPeakAt(recoveryDay) : null;
    const calPrimaryFailure = primaryFailureDay >= 0 ? daysFromPeakAt(primaryFailureDay) : null;
    const calTerminal = terminalLiquidityDay >= 0 ? daysFromPeakAt(terminalLiquidityDay) : null;

    const scenarioRows = new Array(endIdx + 1);
    let cumBtcSoldUsd = 0;
    let cumPaymentsUsd = 0;
    let bcrMinSoFar = Infinity;
    let prevBtcHold = btc0;
    let cumBtcSoldUsdMech = 0;

    for (let i = 0; i <= endIdx; i++) {
        const price = regimePrices[i];
        const btcReserveIndex = btcReservePath[i] / BTC_RESERVE_INITIAL_USD;
        const btcHeldIndex = btcHoldPath[i] / btc0;
        const btcValueUsd = btcHoldPath[i] * price;

        const btcSoldToday = Math.max(0, prevBtcHold - btcHoldPath[i]);
        const btcSoldTodayUsd = btcSoldToday * price;
        const btcSoldTodayFraction = btcSoldToday / btc0;
        cumBtcSoldUsd += btcSoldTodayUsd;
        cumPaymentsUsd += btcSoldTodayUsd;
        prevBtcHold = btcHoldPath[i];

        const btcHeldMechanical = mech.btcHoldPath[i];
        const btcHeldIndexMechanical = btcHeldMechanical / btc0;
        const btcValueUsdMechanical = btcHeldMechanical * price;
        const btcSoldTodayMech = mech.btcSoldTodayPath[i];
        const btcSoldTodayMechFraction = btcSoldTodayMech / btc0;
        const btcSoldTodayMechUsd = btcSoldTodayMech * price;
        cumBtcSoldUsdMech += btcSoldTodayMechUsd;

        if (bcrPath[i] < bcrMinSoFar) bcrMinSoFar = bcrPath[i];

        const stripRow = regimeStrip[i];
        const isLastDayOfMonth = stripRow.is_last_day_of_month;
        const isPaymentDay = cadence === 'daily' ? true : isLastDayOfMonth;
        const obligationFractionThisPayment = cadence === 'daily' ? (1 / 365) : (1 / 12);
        const primaryFailedSoFar = primaryFailureDay >= 0 && i >= primaryFailureDay;
        const terminalReached = terminalLiquidityDay >= 0 && i >= terminalLiquidityDay;
        const recoveredSoFar = recoveryDay >= 0 && i >= recoveryDay;

        const daysToBcrMin = i >= bcrMinDay ? calBcrMin : null;
        const daysToTrough = i >= troughDay ? calTrough : null;
        const daysToRecovery = (recoveryDay >= 0 && i >= recoveryDay) ? calRecovery : null;
        const daysToPrimaryFailure = (primaryFailureDay >= 0 && i >= primaryFailureDay) ? calPrimaryFailure : null;
        const daysToTerminalLiquidity = (terminalLiquidityDay >= 0 && i >= terminalLiquidityDay) ? calTerminal : null;

        scenarioRows[i] = {
            regime: regimeId,
            scenario_id: regimeId + '_bcr' + startingBcr.toFixed(1),
            starting_bcr: startingBcr,

            date: stripRow.date,
            day_index: i,
            days_from_peak: stripRow.days_from_peak,
            is_last_day_of_month: isLastDayOfMonth,

            price_usd: stripRow.price_usd,
            price_normalized: stripRow.price_normalized,
            drawdown_from_peak: stripRow.drawdown_from_peak,
            running_min_price_normalized: stripRow.running_min_price_normalized,
            running_max_drawdown: stripRow.running_max_drawdown,
            daily_return: stripRow.daily_return,
            realized_vol_30d: stripRow.realized_vol_30d,
            btc_price_regime_pctile: stripRow.btc_price_regime_pctile,

            bitcoin_coverage_ratio: bcrPath[i],
            bcr_min_so_far: bcrMinSoFar === Infinity ? null : bcrMinSoFar,
            btc_reserve_index: btcReserveIndex,
            btc_held_index: btcHeldIndex,

            btc_reserve_usd: btcReservePath[i],
            btc_held: btcHoldPath[i],
            btc_value_usd: btcValueUsd,
            annual_obligation_usd: annualObligationUsd,
            monthly_obligation_usd: monthlyObligationUsd,

            is_payment_day: isPaymentDay,
            monthly_obligation_over_annual: isPaymentDay ? obligationFractionThisPayment : 0,
            btc_sold_today_fraction: btcSoldTodayFraction,
            btc_sold_today_usd: btcSoldTodayUsd,
            cumulative_btc_sold_fraction: 1 - btcHeldIndex,
            cumulative_btc_sold_usd: cumBtcSoldUsd,
            cumulative_payments_over_annual: cumPaymentsUsd / annualObligationUsd,
            cumulative_payments_usd: cumPaymentsUsd,

            btc_held_mechanical: btcHeldMechanical,
            btc_held_index_mechanical: btcHeldIndexMechanical,
            btc_value_usd_mechanical: btcValueUsdMechanical,
            btc_sold_today_fraction_mechanical: btcSoldTodayMechFraction,
            btc_sold_today_usd_mechanical: btcSoldTodayMechUsd,
            cumulative_btc_sold_fraction_mechanical: 1 - btcHeldIndexMechanical,
            cumulative_btc_sold_usd_mechanical: cumBtcSoldUsdMech,

            is_trough_day: i === troughDay,
            is_bcr_min_day: i === bcrMinDay,
            is_recovery_day: i === recoveryDay,
            is_primary_failure_day: i === primaryFailureDay,
            has_failed_primary: primaryFailedSoFar,
            reached_recovery: recoveredSoFar,
            is_terminal_liquidity_day: i === terminalLiquidityDay,
            has_reached_terminal_liquidity: terminalReached,

            days_to_trough: daysToTrough,
            days_to_bcr_min: daysToBcrMin,
            days_to_recovery: daysToRecovery,
            days_to_primary_failure: daysToPrimaryFailure,
            days_to_terminal_liquidity: daysToTerminalLiquidity,
        };
    }

    return {
        regimeId,
        startingBcr,
        scenarioId: regimeId + '_bcr' + startingBcr.toFixed(1),
        rows: scenarioRows,
        endIdx,
        bcrMinDay,
        bcrMinVal,
        troughDay,
        troughVal,
        recoveryDay,
        primaryFailureDay,
        terminalLiquidityDay,
        calBcrMin, calTrough, calRecovery, calPrimaryFailure, calTerminal,
        annualObligationUsd,
        monthlyObligationUsd,
        btc0,
        peakPrice,
        terminalBtcHeld: btcHoldPath[endIdx],
        terminalBtcHeldIndex: btcHoldPath[endIdx] / btc0,
        terminalBcr: bcrPath[endIdx],
        terminalBtcReserveIndex: btcReservePath[endIdx] / BTC_RESERVE_INITIAL_USD,
        cumulativeBtcSoldFraction: 1 - btcHoldPath[endIdx] / btc0,
        cumulativeBtcSoldUsd: cumBtcSoldUsd,
        cumulativePaymentsUsd: cumPaymentsUsd,
    };
}

const LONG_CSV_COLUMNS = [
    'regime', 'scenario_id', 'starting_bcr',
    'date', 'day_index', 'days_from_peak', 'is_last_day_of_month',
    'price_usd', 'price_normalized', 'drawdown_from_peak',
    'running_min_price_normalized', 'running_max_drawdown',
    'daily_return', 'realized_vol_30d', 'btc_price_regime_pctile',
    'bitcoin_coverage_ratio', 'bcr_min_so_far',
    'btc_reserve_index', 'btc_held_index',
    'btc_reserve_usd', 'btc_held', 'btc_value_usd',
    'annual_obligation_usd', 'monthly_obligation_usd',
    'is_payment_day', 'monthly_obligation_over_annual',
    'btc_sold_today_fraction', 'btc_sold_today_usd',
    'cumulative_btc_sold_fraction', 'cumulative_btc_sold_usd',
    'cumulative_payments_over_annual', 'cumulative_payments_usd',
    'btc_held_mechanical', 'btc_held_index_mechanical', 'btc_value_usd_mechanical',
    'btc_sold_today_fraction_mechanical', 'btc_sold_today_usd_mechanical',
    'cumulative_btc_sold_fraction_mechanical', 'cumulative_btc_sold_usd_mechanical',
    'is_trough_day', 'is_bcr_min_day', 'is_recovery_day', 'is_primary_failure_day',
    'has_failed_primary', 'reached_recovery',
    'is_terminal_liquidity_day', 'has_reached_terminal_liquidity',
    'days_to_trough', 'days_to_bcr_min', 'days_to_recovery',
    'days_to_primary_failure', 'days_to_terminal_liquidity',
];

module.exports = { buildRegimeStrip, runScenario, LONG_CSV_COLUMNS, BTC_RESERVE_INITIAL_USD, DIV_RATE };
