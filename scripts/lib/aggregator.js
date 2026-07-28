const { BTC_RESERVE_INITIAL_USD } = require('./runner');

function classifyTerminalState(scenario, regimeWindowEndIdx) {
    const { primaryFailureDay, recoveryDay, terminalLiquidityDay, endIdx } = scenario;
    const hitPrimary = primaryFailureDay >= 0;
    const hitTerminal = terminalLiquidityDay >= 0;
    const recovered = recoveryDay >= 0;

    if (hitTerminal) return 'failed_terminal';
    if (hitPrimary) return 'failed_primary';
    if (recovered) return 'recovered';
    return 'censored';
}

function buildScenarioSummaryRow(scenario, regimeWindowEndIdx, regimeBrackets) {
    const terminalState = classifyTerminalState(scenario, regimeWindowEndIdx);
    const firstRow = scenario.rows[0];
    const lastRow = scenario.rows[scenario.endIdx];
    const troughRow = scenario.rows[scenario.troughDay];
    const bcrMinRow = scenario.rows[scenario.bcrMinDay];

    const primaryToTerminalGapDays =
        (scenario.calPrimaryFailure != null && scenario.calTerminal != null)
            ? scenario.calTerminal - scenario.calPrimaryFailure
            : null;

    return {
        regime: scenario.regimeId,
        scenario_id: scenario.scenarioId,
        starting_bcr: scenario.startingBcr,
        terminal_state: terminalState,

        peak_date: firstRow.date,
        peak_price_usd: scenario.peakPrice,
        trough_date: troughRow.date,
        trough_price_usd: scenario.troughVal,
        max_drawdown_from_peak: 1 - (scenario.troughVal / scenario.peakPrice),
        days_to_trough: scenario.calTrough,

        min_bcr: scenario.bcrMinVal,
        min_bcr_date: bcrMinRow.date,
        days_to_bcr_min: scenario.calBcrMin,

        primary_failure_date: scenario.primaryFailureDay >= 0 ? scenario.rows[scenario.primaryFailureDay].date : null,
        days_to_primary_failure: scenario.calPrimaryFailure,

        terminal_liquidity_date: scenario.terminalLiquidityDay >= 0 ? scenario.rows[scenario.terminalLiquidityDay].date : null,
        days_to_terminal_liquidity: scenario.calTerminal,

        primary_to_terminal_gap_days: primaryToTerminalGapDays,

        recovery_date: scenario.recoveryDay >= 0 ? scenario.rows[scenario.recoveryDay].date : null,
        days_to_recovery: scenario.calRecovery,

        terminal_date: lastRow.date,
        terminal_bcr: scenario.terminalBcr,
        terminal_btc_reserve_index: scenario.terminalBtcReserveIndex,
        terminal_btc_held_index: scenario.terminalBtcHeldIndex,

        cumulative_btc_sold_fraction: scenario.cumulativeBtcSoldFraction,
        cumulative_btc_sold_usd: scenario.cumulativeBtcSoldUsd,
        cumulative_payments_usd: scenario.cumulativePaymentsUsd,
        cumulative_payments_over_annual: scenario.cumulativePaymentsUsd / scenario.annualObligationUsd,

        annual_obligation_usd: scenario.annualObligationUsd,
        monthly_obligation_usd: scenario.monthlyObligationUsd,
        btc_at_peak: scenario.btc0,

        required_starting_bcr_lo: regimeBrackets.primary_lo,
        required_starting_bcr_hi: regimeBrackets.primary_hi,
        required_starting_bcr_terminal_lo: regimeBrackets.terminal_lo,
        required_starting_bcr_terminal_hi: regimeBrackets.terminal_hi,

        scenarios_total: regimeBrackets.scenarios_total,
        days_below_bcr_1: countDaysBelow(scenario, 1),
        days_below_bcr_2: countDaysBelow(scenario, 2),
        days_below_bcr_5: countDaysBelow(scenario, 5),
        time_weighted_avg_bcr: timeWeightedAvg(scenario.rows, 'bitcoin_coverage_ratio'),
    };
}

function countDaysBelow(scenario, threshold) {
    let c = 0;
    for (const r of scenario.rows) {
        if (r.bitcoin_coverage_ratio < threshold) c++;
    }
    return c;
}

function timeWeightedAvg(rows, key) {
    if (rows.length === 0) return null;
    let sum = 0;
    for (const r of rows) sum += r[key];
    return sum / rows.length;
}

function computeRegimeBrackets(scenariosInRegime) {
    const sorted = scenariosInRegime.slice().sort((a, b) => a.startingBcr - b.startingBcr);

    let primary_lo = null, primary_hi = null;
    let terminal_lo = null, terminal_hi = null;

    for (const s of sorted) {
        if (s.primaryFailureDay >= 0) {
            if (primary_lo === null || s.startingBcr > primary_lo) primary_lo = s.startingBcr;
        } else {
            if (primary_hi === null || s.startingBcr < primary_hi) primary_hi = s.startingBcr;
        }
        if (s.terminalLiquidityDay >= 0) {
            if (terminal_lo === null || s.startingBcr > terminal_lo) terminal_lo = s.startingBcr;
        } else {
            if (terminal_hi === null || s.startingBcr < terminal_hi) terminal_hi = s.startingBcr;
        }
    }

    return {
        primary_lo, primary_hi,
        terminal_lo, terminal_hi,
        scenarios_total: scenariosInRegime.length,
    };
}

function buildRegimeDescriptor(regimeDef, regimeFullWindowRows, peakIdxInFull, scenariosInRegime, bracketData) {
    const stats = require('./stats');
    const peakRow = regimeFullWindowRows[0];
    const peakPrice = peakRow.priceUsd;
    let troughIdx = 0;
    let troughPrice = Infinity;
    for (let i = 0; i < regimeFullWindowRows.length; i++) {
        if (regimeFullWindowRows[i].priceUsd < troughPrice) {
            troughPrice = regimeFullWindowRows[i].priceUsd;
            troughIdx = i;
        }
    }
    const maxDrawdownPct = 1 - (troughPrice / peakPrice);
    const daysPeakToTroughCalendar = stats.calendarDaysBetween(peakRow.date, regimeFullWindowRows[troughIdx].date);
    const drawdownShapeRatio = daysPeakToTroughCalendar > 0 ? (maxDrawdownPct / daysPeakToTroughCalendar) : null;

    let firstRecoveryIdx = -1;
    let sawPriceDip = false;
    for (let i = 1; i < regimeFullWindowRows.length; i++) {
        if (!sawPriceDip) {
            if (regimeFullWindowRows[i].priceUsd < peakPrice) sawPriceDip = true;
        } else {
            if (regimeFullWindowRows[i].priceUsd >= peakPrice) { firstRecoveryIdx = i; break; }
        }
    }
    const daysPeakToRecoveryCalendar = firstRecoveryIdx >= 0
        ? stats.calendarDaysBetween(peakRow.date, regimeFullWindowRows[firstRecoveryIdx].date)
        : null;
    const regimeWindowLengthCalendar = stats.calendarDaysBetween(
        regimeFullWindowRows[0].date,
        regimeFullWindowRows[regimeFullWindowRows.length - 1].date
    );

    return {
        regime: regimeDef.id,
        label: regimeDef.label,
        peak_date: peakRow.dateStr,
        peak_price_usd: peakPrice,
        btc_at_peak_given_1b_reserve: 1_000_000_000 / peakPrice,
        trough_date: regimeFullWindowRows[troughIdx].dateStr,
        trough_price_usd: troughPrice,
        max_drawdown_from_peak: maxDrawdownPct,
        days_peak_to_trough: daysPeakToTroughCalendar,
        drawdown_shape_ratio: drawdownShapeRatio,
        recovery_date: firstRecoveryIdx >= 0 ? regimeFullWindowRows[firstRecoveryIdx].dateStr : null,
        days_peak_to_recovery: daysPeakToRecoveryCalendar,
        n_days: daysPeakToRecoveryCalendar + 1,
        regime_window_start: peakRow.dateStr,
        regime_window_end: regimeFullWindowRows[regimeFullWindowRows.length - 1].dateStr,
        regime_window_length_days: regimeWindowLengthCalendar,
        required_starting_bcr_lo: bracketData.primary_lo,
        required_starting_bcr_hi: bracketData.primary_hi,
        required_starting_bcr_terminal_lo: bracketData.terminal_lo,
        required_starting_bcr_terminal_hi: bracketData.terminal_hi,
        selection_rationale: regimeDef.selection_rationale,
    };
}

const SUMMARY_COLUMNS = [
    'regime', 'scenario_id', 'starting_bcr', 'terminal_state',
    'peak_date', 'peak_price_usd', 'trough_date', 'trough_price_usd',
    'max_drawdown_from_peak', 'days_to_trough',
    'min_bcr', 'min_bcr_date', 'days_to_bcr_min',
    'primary_failure_date', 'days_to_primary_failure',
    'terminal_liquidity_date', 'days_to_terminal_liquidity',
    'primary_to_terminal_gap_days',
    'recovery_date', 'days_to_recovery',
    'terminal_date', 'terminal_bcr', 'terminal_btc_reserve_index', 'terminal_btc_held_index',
    'cumulative_btc_sold_fraction', 'cumulative_btc_sold_usd',
    'cumulative_payments_usd', 'cumulative_payments_over_annual',
    'annual_obligation_usd', 'monthly_obligation_usd', 'btc_at_peak',
    'required_starting_bcr_lo', 'required_starting_bcr_hi',
    'required_starting_bcr_terminal_lo', 'required_starting_bcr_terminal_hi',
    'scenarios_total',
    'days_below_bcr_1', 'days_below_bcr_2', 'days_below_bcr_5',
    'time_weighted_avg_bcr',
];

const DESCRIPTOR_COLUMNS = [
    'regime', 'label',
    'peak_date', 'peak_price_usd', 'btc_at_peak_given_1b_reserve',
    'trough_date', 'trough_price_usd',
    'max_drawdown_from_peak', 'days_peak_to_trough',
    'drawdown_shape_ratio',
    'recovery_date', 'days_peak_to_recovery', 'n_days',
    'regime_window_start', 'regime_window_end', 'regime_window_length_days',
    'required_starting_bcr_lo', 'required_starting_bcr_hi',
    'required_starting_bcr_terminal_lo', 'required_starting_bcr_terminal_hi',
    'selection_rationale',
];

module.exports = {
    classifyTerminalState,
    buildScenarioSummaryRow,
    computeRegimeBrackets,
    buildRegimeDescriptor,
    SUMMARY_COLUMNS,
    DESCRIPTOR_COLUMNS,
};
