#!/usr/bin/env bash
set -euo pipefail

ARD_ROOT=${ARD_ROOT:-/home/user/RustDebug/rust-debugger-DA}
LILOS_ROOT=${LILOS_ROOT:-/home/user/lilos}
LILOS_TESTSUITE_SRC=${LILOS_TESTSUITE_SRC:-$LILOS_ROOT/testsuite/src}
LILOS_ELF=${LILOS_ELF:-$LILOS_ROOT/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965}
PORT=${2:-1234}
MODE=${1:-qemu}

usage() {
    cat <<'EOF'
Usage: ./run_lilos.sh [qemu|gdb] [port]

qemu: start the LM3S6965 test binary paused with a GDB stub.
gdb:  attach gdb-multiarch to an already-running stub.
EOF
}

if [[ ! -d "$LILOS_TESTSUITE_SRC" ]]; then
    echo "[lilos] source directory not found: $LILOS_TESTSUITE_SRC" >&2
    exit 1
fi

if [[ ! -x "$LILOS_ELF" ]]; then
    echo "[lilos] debug ELF not found: $LILOS_ELF" >&2
    exit 1
fi

echo "[lilos] source: $LILOS_TESTSUITE_SRC"
echo "[lilos] ELF:    $LILOS_ELF"
echo "[lilos] GDB:    :$PORT"

case "$MODE" in
    qemu)
        exec qemu-system-arm \
            -cpu cortex-m3 \
            -machine lm3s6965evb \
            -nographic \
            -semihosting-config enable=on,target=native \
            -gdb "tcp::$PORT" \
            -S \
            -kernel "$LILOS_ELF"
        ;;
    gdb)
        exec gdb-multiarch -q "$LILOS_ELF" -ex "target remote :$PORT"
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        usage >&2
        exit 2
        ;;
esac
