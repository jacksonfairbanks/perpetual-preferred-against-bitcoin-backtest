#!/usr/bin/env bash
# Hash-verify the bundled artifacts of perpetual-preferred-against-bitcoin-backtest.
# Bundled files: enforced (script exits nonzero on any mismatch).
# Optional files (the two large bcr_paths_daily.csv outputs that are not bundled):
# expected hashes are documented; checks fire only if the file exists locally.
#
# Run from the repo root:
#   ./verify.sh
#
# Windows: run under Git Bash, WSL, or compare against the values below using
# `Get-FileHash -Algorithm SHA256`.

set -u

# Pick a sha256 binary. macOS ships `shasum`, Linux/Git-Bash ship `sha256sum`.
if command -v sha256sum >/dev/null 2>&1; then
    SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA="shasum -a 256"
else
    echo "ERROR: no sha256sum or shasum available on PATH." >&2
    exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
SKIP=0

check() {
    # check <expected_sha> <relative_path>
    local expected="$1"
    local file="$2"
    local optional="${3:-required}"
    if [ ! -f "$file" ]; then
        if [ "$optional" = "optional" ]; then
            echo "[SKIP] $file (not present locally; regenerable from node scripts/export.js)"
            SKIP=$((SKIP + 1))
            return
        else
            echo "[FAIL] $file (missing)"
            FAIL=$((FAIL + 1))
            return
        fi
    fi
    local actual
    actual=$($SHA "$file" | awk '{print $1}')
    if [ "$actual" = "$expected" ]; then
        echo "[PASS] $file"
        PASS=$((PASS + 1))
    else
        echo "[FAIL] $file"
        echo "       expected: $expected"
        echo "       got:      $actual"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Bundled files (enforced) ==="

# Engine + scripts
check e29e1d1e9621c85d8997389e20c1c6c727e4a2fa44abe33bdb6963ee6e4ff00e src/solvency-engine.js
check 37263751c836134d5f61f0302b4f96d35eb92b86a05c7dda2f9c54c9c6f42bfe scripts/preprocess-bitstamp.js
check 98c393505e28a96ad926bb071a1e7d765b71314cb2f119c28c54af6d4ba0dac7 scripts/export.js
check 008d24b4fd35b3103e124c40bbc7af933f98339758e78b9d359ce9ab04eaf011 scripts/lib/engine.js
check 271077a91043a39518cca5e9da22fc35d1a804ec1673405a03908b0a23418ce5 scripts/lib/runner.js
check 4d1082cb22a14fc056713931bc5a4b69b0c4185403d8e11f520a591903784679 scripts/lib/aggregator.js
check 3fc55a9fa75318a2f1e360bbf9b4801cf945d167aac60c88c62d147302aa272c scripts/lib/monthly.js
check ece79d334bbb9085c5452feeb05f76cf2b015f3aec482836e59ae070cc1a24ba scripts/lib/prices.js
check 531a50fbd15b35f3d86a99ad68c7604645b87b575fd3dd7a8019daf13cb20c7c scripts/lib/regimes.js
check e346d8e686bc00b658f4aa953ffba344240bf092830ace380d1293cf7235ecec scripts/lib/stats.js
check d4293ab598c2daeb27c97329de6af41c30b1f06136ca21127ec9bdd913aa906c scripts/lib/writers.js
check 500cc725eb869fa9b67d9dcfe4d71744069c1e3d5341cfe232b646ee373986f2 scripts/derive-mech-chart-data.js
check 0c4b82a3d669d9d79c5bebc732b82559f58ae99b6a7fa40159fc01f8780d672d scripts/build-surface.js
check 0353bc3b1ca8f61fb33e1274e35e3f1f1ce66cf39fad0f0136c33c0acfc1e066 scripts/build-surface-grid-validation.js
check 6de7cd597a28978fffaef4f02c6c5eb9e52b986ddf17f4ce0bb7a9baa2091ce5 scripts/bake-viewer.js

# Interactive viewer (snapshot of outputs/surface_grid.csv; regenerable via scripts/bake-viewer.js)
check cbd62d8bd0940b249bc8656bc874cd0343097b12ee5566b6bb98622d9c14b838 bcr_3d_viewer.html

# Price sources (cited in paper Appendix C)
check 978ad50a50bf22be09d9a18b1517202d71f15cea7bed46d93e445a3af1810146 data/btc-prices-bitstamp.csv
check e485212cb35e1a37a8db3bb388f04ddf8ff294708238752fbfb02f3e1d02d6ec data/btc-prices-bitstamp-imputation.json
check 690e81b45a03c35b45a907a1baab2e44532f33ac4c5c5f152457f3c1b63e1eba data/btc-prices-coinmetrics.csv
check 94e9e11b9aa931fcbd64f1984b708206ec961133b1ef2b026717afcce5325c6b data/raw/bitstamp_btc_prices.csv

# Bundled outputs (monthly cadence)
check 83692764d677727252001655ed954dc7b4b13ee52efabd95a080feae532b743f outputs/regime_summary.csv
check 0f621d60edff8a3a39e7bafd18f59e3c776c0382f70f4d6797b4b057f21615d4 outputs/regime_descriptors.csv
check e438994b112ea73dd326f4dd7d91e24ebc8386d9c79c149657e7bff3f63abee9 outputs/bcr_paths_monthly.csv
check 6ec31333e42d1797186f4ef6116fa3c94b77401081c1754da6cb3d60d652dfd1 outputs/transition_paths_monthly.csv
check c76efa94fa5086526d545676649eab2e3bb3f8d4c1a219fdb55e224694d8da10 outputs/min_bcr_chart_data_mech.csv

# Bundled outputs (surface build, paper §6.6)
check 77f1454383b82821bbda3d6e8a66aa1100fffda11d9aaa026756873b2e25bef5 outputs/regime_tau_sigma.csv
check e6dcee1bed5a26a371252bf4d22083be1ecdb61ab182dafe7676088cd53f227f outputs/time_at_depth_distributions.csv
check 44d782f8b53c1c03d6fa7be1a4ea985c1fb388cf6e86e5efbcef73ed6f246d65 outputs/surface_validation.csv
check d5fe08427c4dc567f5d1f4ce5372057b0c134960ebb2e01a29c91d1fd76b7bed outputs/surface_grid.csv
check 4c5c8a84f67795985bba588d09d97c55e572fa739c9f21575adc4fa1c923f2aa outputs/surface_grid_validation.csv

# Bundled outputs (daily cadence)
check 3be2237954baec3beb0d23c6465aae064c58310cf1e54bcd974de7bd416e5051 outputs/daily/regime_summary.csv
check 032c819ce7e95a91a23be18b8ea5c138aa5fa671d59d8f7a130b5da54beefd36 outputs/daily/regime_descriptors.csv
check cd2fd17e231adca508661a06d562b76a313b358a2647c51b2a3e5a7995a1f19b outputs/daily/bcr_paths_monthly.csv
check 28711ddcd60686f268e30f901de05630db9f90d155080bb4cdac2fed092c9b04 outputs/daily/transition_paths_monthly.csv
check 9b78f4f5c86184b0e1f786e3c880b5cab300987ab31c8835e3b61a69447c8440 outputs/daily/min_bcr_chart_data_mech.csv

# manifest.json: contents include a wall-clock run_timestamp, so SHA depends on
# when the bundled run happened. The bundled hashes below are for the published
# snapshot; if you re-run the export locally, your manifest.json hash will
# legitimately differ and these two checks will FAIL by design. Skip them in
# that case; the bundled snapshot manifests are kept for reviewer reference.
check bc43f890ae1153bda8c0871609ac5ea2ee6cc38aed510c6123a767fc2f540bf5 outputs/manifest.json
check ac05e49611b9038857f3622cf7194134f7e02f7b484ce838eba5411d06a6431f outputs/daily/manifest.json

echo
echo "=== Optional / regenerable files (only checked if present) ==="

# bcr_paths_daily.csv files are not bundled (over GitHub's 100 MB per-file limit).
# Run `node scripts/export.js` and `node scripts/export.js --cadence=daily` to regenerate.
check e037f425704b3b67a7e209ac17e8fdd8c27e3dbf1c1d38cf139e6cb8bf77204a outputs/bcr_paths_daily.csv optional
check 9ab88a41de821f78d13a2b6fd3a965d8e076d2ae6468088f3d3f042b13e8c3fa outputs/daily/bcr_paths_daily.csv optional

echo
echo "=== Summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP (regenerable from node scripts/export.js; not bundled)"
echo

if [ "$FAIL" -gt 0 ]; then
    echo "RESULT: $FAIL file(s) failed verification."
    exit 1
fi
echo "RESULT: ALL BUNDLED FILES PASS"
exit 0
