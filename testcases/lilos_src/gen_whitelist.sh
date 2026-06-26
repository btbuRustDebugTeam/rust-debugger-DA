#!/usr/bin/env bash
set -euo pipefail

ARD_ROOT=${ARD_ROOT:-/home/user/RustDebug/rust-debugger-DA}
LILOS_ROOT=${LILOS_ROOT:-/home/user/lilos}
LILOS_TESTSUITE_SRC=${LILOS_TESTSUITE_SRC:-$LILOS_ROOT/testsuite/src}
LILOS_BUILD_DIR=${LILOS_BUILD_DIR:-$LILOS_ROOT/testsuite/lm3s6965}
LILOS_ELF=${LILOS_ELF:-$LILOS_ROOT/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965}
TESTCASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMP_DIR="$TESTCASE_DIR/temp"
LOG_DIR="$ARD_ROOT/temp/logs"
DEBUG_LOG="$LOG_DIR/lilos_whitelist_debug.log"
RAW="$TEMP_DIR/poll_functions.ardb-generated.$(date +%Y%m%d_%H%M%S).txt"
OUT="$TEMP_DIR/poll_functions.txt"
INFO_FUNCTIONS="$TEMP_DIR/logs/lilos_info_functions.txt"

if [[ ! -d "$LILOS_TESTSUITE_SRC" ]]; then
    echo "[lilos] source directory not found: $LILOS_TESTSUITE_SRC" >&2
    exit 1
fi

if [[ ! -x "$LILOS_ELF" ]]; then
    echo "[lilos] debug ELF not found: $LILOS_ELF" >&2
    exit 1
fi

mkdir -p "$TEMP_DIR/logs"
mkdir -p "$LOG_DIR"
echo "[lilos] source: $LILOS_TESTSUITE_SRC"
echo "[lilos] ELF:    $LILOS_ELF"

{
    echo "===== LILO whitelist debug ====="
    date
    echo "ELF=$LILOS_ELF"
    echo "SOURCE_ROOT=$LILOS_TESTSUITE_SRC"
    echo "BUILD_DIR=$LILOS_BUILD_DIR"
} > "$DEBUG_LOG"

if ! readelf -S "$LILOS_ELF" | grep -q ' \.text '; then
    {
        echo "rejected reason: ELF has no .text section; rebuilding from lm3s6965 crate-local Cargo config"
        echo "build command: cd $LILOS_BUILD_DIR && cargo build"
    } >> "$DEBUG_LOG"
    (cd "$LILOS_BUILD_DIR" && cargo build)
fi

gdb-multiarch -q -batch "$LILOS_ELF" \
    -ex 'set pagination off' \
    -ex 'info functions' > "$INFO_FUNCTIONS" 2>>"$DEBUG_LOG" || true

RAW_INFO_COUNT=$(grep -cE '^[0-9]+:[[:space:]]+' "$INFO_FUNCTIONS" || true)
echo "raw info functions count=$RAW_INFO_COUNT" >> "$DEBUG_LOG"

PYTHONPATH="$ARD_ROOT" \
ASYNC_RUST_DEBUGGER_TEMP_DIR="$TEMP_DIR" \
gdb-multiarch -q -batch "$LILOS_ELF" \
    -ex 'set pagination off' \
    -ex 'python import async_rust_debugger' \
    -ex 'ardb-gen-whitelist'

cp "$OUT" "$RAW"

python3 - "$RAW" "$OUT" "$INFO_FUNCTIONS" "$DEBUG_LOG" <<'PY'
import re
import sys
from pathlib import Path

raw_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
info_path = Path(sys.argv[3])
log_path = Path(sys.argv[4])

raw_symbols = []
for line in raw_path.read_text(encoding="utf-8").splitlines():
    m = re.match(r"\s*\d+\s+(.+?)\s*$", line)
    if m:
        raw_symbols.append(m.group(1))

info_text = info_path.read_text(encoding="utf-8", errors="replace")

stable = [
    "lilos_testsuite::run_test_suite",
    "lilos::exec::run_tasks",
    "lilos::exec::Notify::notify",
    "lilos::exec::YieldCpu::poll",
    "lilos::exec::{impl#6}::poll",
    "lilos_testsuite::task_coordinator::{async_fn#0}::{async_block#0}",
    "lilos::time::{impl#8}::poll<lilos::time::sleep_until::{async_fn_env#0}, lilos_testsuite::task_coordinator::{async_fn#0}::{async_block_env#0}>",
]

final = []
rejected = []

def add(sym: str, source: str):
    if sym not in final:
        final.append(sym)

for sym in stable:
    if sym == "lilos::exec::YieldCpu::poll" and sym not in info_text:
        rejected.append(
            f"{sym}: not a GDB-resolved name in this ELF; kept as compatibility alias, "
            "actual poll location is lilos::exec::{impl#6}::poll"
        )
        add(sym, "stable-alias")
        continue
    if sym in info_text:
        add(sym, "stable")
    else:
        rejected.append(f"{sym}: not found in raw info functions")
        add(sym, "stable-fallback")

for sym in raw_symbols:
    add(sym, "raw-poll")

if not final and raw_symbols:
    rejected.append("filtered stable set was empty; falling back to raw ardb-gen-whitelist output")
    final = list(dict.fromkeys(raw_symbols))

if not final:
    raise SystemExit("final LILO whitelist is empty; no raw or stable candidates available")

out_path.write_text(
    "".join(f"{i} {sym}\n" for i, sym in enumerate(final)),
    encoding="utf-8",
)

with log_path.open("a", encoding="utf-8") as log:
    log.write(f"raw ardb-gen-whitelist count={len(raw_symbols)}\n")
    log.write(f"filtered count={len(final)}\n")
    log.write("rejected reason:\n")
    if rejected:
        for item in rejected:
            log.write(f"- {item}\n")
    else:
        log.write("- none\n")
    log.write("final whitelist list:\n")
    for i, sym in enumerate(final):
        log.write(f"{i} {sym}\n")
PY

echo "[lilos] raw Poll candidates: $RAW"
echo "[lilos] curated whitelist:  $OUT"
echo "[lilos] debug log:          $DEBUG_LOG"
