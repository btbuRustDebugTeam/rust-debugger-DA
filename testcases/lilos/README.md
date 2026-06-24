# LILO ARD Script Driver

This testcase contains no LILO source tree or build artifacts. The authoritative
source is `/home/user/lilos/testsuite/src`; the matching LM3S6965 debug ELF is
`/home/user/lilos/target/thumbv7m-none-eabi/debug/lilos-testsuite-lm3s6965`.

## Generate The Whitelist

```bash
./gen_whitelist.sh
```

The script invokes the existing ARD static generator against the external ELF,
keeps its raw Poll-return candidates in `temp/`, and writes a curated runtime
whitelist to `temp/poll_functions.txt`. The curated entries cover testsuite
entry, `run_tasks`, `Notify::notify`, coordinator task polling, and the
timeout/yield inner poll chain.

## Run And Attach

Terminal 1 starts a paused LM3S QEMU instance with a GDB stub:

```bash
./run_lilos.sh qemu 1234
```

Terminal 2 attaches native multiarch GDB:

```bash
./run_lilos.sh gdb 1234
source attach.gdb
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/lilos/temp/poll_functions.txt
ardb-trace lilos_testsuite::run_test_suite
continue
```

After a poll hit, inspect and validate the runtime graph:

```gdb
ardb-get-history-tree
ardb-validate-history-tree
```

Expected execution path:

```text
lilos_testsuite::run_test_suite
-> lilos::exec::run_tasks
-> lilos::time::TimeLimited::poll<sleep_until, task_coordinator>
-> lilos_testsuite::task_coordinator::{async_block#0}
-> lilos::exec::YieldCpu::poll
```

The external LILO source is read-only from ARD's perspective. Local `temp/`
contains only whitelist output and logs.
