function condenseScenarioToMonthly(scenario) {
    const kept = new Set();
    const rows = scenario.rows;
    if (rows.length === 0) return [];

    kept.add(0);
    kept.add(rows.length - 1);

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.is_last_day_of_month) kept.add(i);
        if (r.is_trough_day) kept.add(i);
        if (r.is_bcr_min_day) kept.add(i);
        if (r.is_recovery_day) kept.add(i);
        if (r.is_primary_failure_day) kept.add(i);
        if (r.is_terminal_liquidity_day) kept.add(i);
    }

    const indices = Array.from(kept).sort((a, b) => a - b);
    return indices.map(i => rows[i]);
}

module.exports = { condenseScenarioToMonthly };
