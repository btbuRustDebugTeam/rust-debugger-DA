#!/usr/bin/env bash
set -euo pipefail

QEMU=${QEMU:-/home/user/AsyncOS/taic-qemu/build/qemu-system-riscv64}
REL4_WORKSPACE=${REL4_WORKSPACE:-/home/user/AsyncOS/rel4-manifest-workspace}
IMAGE=${IMAGE:-"$REL4_WORKSPACE/rel4_kernel/build-rel4-async-debuginfo-only/images/example-image-riscv-spike"}

if [[ ! -x "$QEMU" ]]; then
    echo "[rel4-async] QEMU executable not found: $QEMU" >&2
    exit 1
fi

if [[ ! -f "$IMAGE" ]]; then
    echo "[rel4-async] boot image not found: $IMAGE" >&2
    exit 1
fi

echo "[rel4-async] image: $IMAGE"
echo "[rel4-async] starting QEMU paused with GDB stub on localhost:1234"

exec "$QEMU" \
    -machine virt \
    -cpu rvgcsu-n \
    -nographic \
    -serial mon:stdio \
    -m size=4095M \
    -bios none \
    -kernel "$IMAGE" \
    -smp 2 \
    -S \
    -s
