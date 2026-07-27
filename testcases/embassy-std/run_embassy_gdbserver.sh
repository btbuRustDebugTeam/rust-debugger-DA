#!/usr/bin/env bash
set -euo pipefail

EMBASSY_ROOT=${EMBASSY_ROOT:-/home/user/embassy}
EMBASSY_STD_DIR=${EMBASSY_STD_DIR:-"$EMBASSY_ROOT/examples/std"}
PORT=${PORT:-${1:-1234}}
BINARY="$EMBASSY_STD_DIR/target/debug/tick"

if [[ ! -d "$EMBASSY_STD_DIR" ]]; then
    echo "[embassy-std] source directory not found: $EMBASSY_STD_DIR" >&2
    exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "[embassy-std] cargo is not installed" >&2
    exit 1
fi

if ! command -v gdbserver >/dev/null 2>&1; then
    echo "[embassy-std] gdbserver is not installed" >&2
    exit 1
fi

echo "[embassy-std] building tick in $EMBASSY_STD_DIR"
(
    cd "$EMBASSY_STD_DIR"
    cargo build --bin tick
)

if [[ ! -x "$BINARY" ]]; then
    echo "[embassy-std] debug ELF not found after build: $BINARY" >&2
    exit 1
fi

echo "[embassy-std] ELF: $BINARY"
echo "[embassy-std] starting gdbserver on localhost:$PORT"
exec gdbserver ":$PORT" "$BINARY"
