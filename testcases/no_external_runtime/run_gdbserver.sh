#!/usr/bin/env bash
set -euo pipefail

TESTCASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PORT=${1:-1234}
BINARY="$TESTCASE_DIR/target/debug/no_runtime_futures"

if [[ ! -x "$BINARY" ]]; then
  cargo build --manifest-path "$TESTCASE_DIR/Cargo.toml"
fi

if ! command -v gdbserver >/dev/null 2>&1; then
  echo "[no_external_runtime] gdbserver is not installed" >&2
  exit 1
fi

echo "[no_external_runtime] starting: gdbserver :$PORT $BINARY"
exec gdbserver ":$PORT" "$BINARY"
