# LILO ARD Source Workspace

This is the single ARD entry point for the LILO testcase. It exposes the real
LILO testsuite source through:

```text
src -> /home/user/lilos/testsuite/src
```

The debug ELF is:

```text
/home/user/lilos/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965
```

This workspace does not use `cppdbg`, a third-party `gdb` debug type, or a
preLaunch task to manage QEMU. Runtime ownership stays manual so VS Code cannot
start or kill the QEMU GDB stub.

## Step 1: Start QEMU Manually

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/lilos_src
./run_lilos.sh qemu 1234
```

If the port is busy, clean up the old runtime first:

```bash
pkill -f qemu-system-arm || true
pkill -f gdb-multiarch || true
sleep 1
```

## Step 2: Start The ARD Extension Host

From the ARD repository root:

```bash
cd /home/user/RustDebug/rust-debugger-DA
code .
```

Choose:

```text
Extension Development Host (with lilos)
```

It opens:

```text
testcases/lilos_src
```

## Step 3: Attach From VS Code

In the `testcases/lilos_src` Extension Development Host, choose:

```text
Attach to :1234 (ARD)
```

This starts the ARD debug adapter with `gdb-multiarch` and leaves the QEMU
process under manual control. You can also use the ARD UI `Connect :1234`
button if you started an ARD session before connecting.

## Step 4: Load ARD State Manually

If ARD commands are not already installed, run this in the Debug Console or GDB:

```gdb
source /home/user/RustDebug/rust-debugger-DA/testcases/lilos_src/attach.gdb
```

Then run:

```gdb
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/lilos_src/temp/poll_functions.txt
ardb-trace lilos_testsuite::run_test_suite
break lilos::exec::YieldCpu::poll
continue
```

When execution stops, click:

```text
History
```

Expected graph:

```text
lilos_testsuite::run_test_suite
-> lilos::exec::run_tasks
-> lilos::time::TimeLimited::poll<...task_coordinator...>
-> lilos_testsuite::task_coordinator::{async_block#0}
-> lilos::exec::YieldCpu::poll
```

No ARD runtime, whitelist generator, graph builder, UI code, or LILO source is
modified by this workspace.
