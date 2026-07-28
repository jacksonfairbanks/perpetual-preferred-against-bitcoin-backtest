const { parseIsoDate } = require('./prices');

function addYears(d, years) {
    return new Date(d.getFullYear() + years, d.getMonth(), d.getDate());
}

const REGIMES = [
    {
        id: 'early_2011',
        label: '2011 early-market collapse',
        peakSearchStart: '2011-06-08',
        peakSearchEnd:   '2011-06-08',
        regimeLengthYears: 4,
        dataSource: 'coinmetrics_2011',
        selection_rationale: 'First observable BTC boom-bust; peak-to-trough ~93% in ~5 months, then ~1.7-year recovery. Included from CoinMetrics because Bitstamp data begins 2011-08-18, after the canonical June 2011 peak. Tests the framework under the deepest historical drawdown on record.',
    },
    {
        id: 'apr_2013',
        label: '2013 April flash crash',
        peakSearchStart: '2013-04-09',
        peakSearchEnd:   '2013-04-09',
        regimeLengthYears: 4,
        dataSource: 'bitstamp',
        selection_rationale: 'Post-Cyprus parabolic run followed by a 7-day 70% flash crash (2013-04-09 to 2013-04-16: $229 to $68.09) triggered by Mt. Gox DDoS and the Instawallet theft cascade. Prices bounced into the $120-140 range through May before a second leg down set the regime-wide trough at $66.34 on 2013-07-06 (71.0% peak-to-trough; 88 calendar days). Recovery to the April peak: 210 days. Distinguished from the other regimes by the fastest major initial leg on record combined with a double-bottom structure, stressing the framework against a short violent shock followed by a months-long echo rather than a single grinding bear.',
    },
    {
        id: 'mtgox_2014',
        label: '2014 Mt. Gox collapse',
        peakSearchStart: '2013-07-01',
        peakSearchEnd:   '2014-06-30',
        regimeLengthYears: 4,
        dataSource: 'bitstamp',
        selection_rationale: 'First full BTC bear-cycle with exchange-level counterparty failure; longest historical peak-to-recovery duration at roughly 3.25 years, stressing any forward-coverage framework over a grinding drawdown.',
    },
    {
        id: 'ico_2018',
        label: '2018 ICO bubble unwind',
        peakSearchStart: '2017-06-01',
        peakSearchEnd:   '2018-01-31',
        regimeLengthYears: 4,
        dataSource: 'bitstamp',
        selection_rationale: 'Post-parabolic speculative unwind with peak-to-trough drawdown ~84% and ~3-year recovery; captures extended distressed grind without a concurrent macro shock.',
    },
    {
        id: 'covid_2020',
        label: '2020 COVID liquidity shock',
        peakSearchStart: '2020-01-01',
        peakSearchEnd:   '2020-03-15',
        regimeLengthYears: 4,
        dataSource: 'bitstamp',
        selection_rationale: 'Cross-asset liquidity shock producing a near-instantaneous ~50% drawdown followed by rapid recovery; tests forward-coverage framework against steep, short tail events rather than grinding bears.',
    },
    {
        id: 'fed_2022',
        label: '2022 Fed tightening drawdown',
        peakSearchStart: '2021-06-01',
        peakSearchEnd:   '2022-01-31',
        regimeLengthYears: 4,
        dataSource: 'bitstamp',
        selection_rationale: 'Macro-driven drawdown during aggressive monetary tightening with ~77% peak-to-trough and concurrent crypto-native failures (LUNA, 3AC, FTX); representative of a policy-tightening regime.',
    },
];

function resolveRegimeDates(regime) {
    const peakSearchStart = parseIsoDate(regime.peakSearchStart);
    const peakSearchEnd   = parseIsoDate(regime.peakSearchEnd);
    return {
        ...regime,
        peakSearchStartDate: peakSearchStart,
        peakSearchEndDate: peakSearchEnd,
        windowEndAfterPeak: (peakDate) => addYears(peakDate, regime.regimeLengthYears),
    };
}

module.exports = { REGIMES, resolveRegimeDates };
