#!/usr/bin/env bash
set -euo pipefail

ARD_ROOT=${ARD_ROOT:-/home/user/RustDebug/rust-debugger-DA}
LILOS_ROOT=${LILOS_ROOT:-/home/user/lilos}
LILOS_TESTSUITE_SRC=${LILOS_TESTSUITE_SRC:-$LILOS_ROOT/testsuite/src}
LILOS_ELF=${LILOS_ELF:-$LILOS_ROOT/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965}
TESTCASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LOG_DIR="$TESTCASE_DIR/temp/logs"
PORT=${2:-1234}
MODE=${1:-qemu}

usage() {
    cat <<'EOF'
Usage: ./run_lilos.sh [qemu|gdb] [port]

qemu: start the LM3S6965 test binary paused with a GDB stub.
gdb:  attach gdb-multiarch to an already-running stub.
EOF
}

port_is_open() {
    (echo >"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
}

wait_for_gdb_stub() {
    local qemu_pid=$1

    echo "[lilos] waiting gdb stub..."
    for _ in {1..50}; do
        if ! kill -0 "$qemu_pid" 2>/dev/null; then
            wait "$qemu_pid"
            exit $?
        fi
        if port_is_open; then
            echo "[lilos] gdb stub ready: localhost:$PORT"
            return 0
        fi
        sleep 0.2
    done

    echo "[lilos] timed out waiting for gdb stub on localhost:$PORT" >&2
    kill "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
    exit 1
}

if [[ ! -d "$LILOS_TESTSUITE_SRC" ]]; then
    echo "[lilos] source directory not found: $LILOS_TESTSUITE_SRC" >&2
    exit 1
fi

if [[ ! -x "$LILOS_ELF" ]]; then
    echo "[lilos] debug ELF not found: $LILOS_ELF" >&2
    echo "[lilos] build failed or target was not built; try:" >&2
    echo "[lilos]   cd $LILOS_ROOT && cargo build --target thumbv7m-none-eabi -p lilos-testsuite-lm3s6965" >&2
    exit 1
fi

echo "[lilos] source: $LILOS_TESTSUITE_SRC"
echo "[lilos] ELF:    $LILOS_ELF"
echo "[lilos] GDB:    :$PORT"

case "$MODE" in
    qemu)
        if port_is_open; then
            echo "[lilos] port already in use: localhost:$PORT" >&2
            echo "[lilos] stop the old QEMU/GDB stub before starting a new one" >&2
            exit 1
        fi

        mkdir -p "$LOG_DIR"
        qemu_log="$LOG_DIR/qemu_lm3s6965_${PORT}.log"
        qemu_pid_file="$LOG_DIR/qemu_lm3s6965_${PORT}.pid"
        echo "[lilos] QEMU log: $qemu_log"

        nohup setsid qemu-system-arm \
            -cpu cortex-m3 \
            -machine lm3s6965evb \
            -nographic \
            -semihosting-config enable=on,target=native \
            -gdb "tcp::$PORT" \
            -S \
            -kernel "$LILOS_ELF" \
            >"$qemu_log" 2>&1 </dev/null &
        qemu_pid=$!
        echo "$qemu_pid" > "$qemu_pid_file"

        trap 'echo "[lilos] task stopped; detached QEMU remains pid=$qemu_pid"; exit 0' INT TERM
        wait_for_gdb_stub "$qemu_pid"
        while kill -0 "$qemu_pid" 2>/dev/null; do
            sleep 30
        done
        wait "$qemu_pid" 2>/dev/null || true
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
