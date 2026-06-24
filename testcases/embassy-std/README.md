# Embassy std ARD testcase

This testcase validates ARD against Embassy's host-std executor, without QEMU or
a kernel. `tick` is the default: it runs one async task forever and awaits an
`embassy_time::Timer` once per second. `tick_cancel` is the five-second,
controlled-stop comparison case.

## Quick local validation

```bash
./build_examples.sh tick
./gen_whitelist.sh tick
./verify_local_gdb.sh
```

The expected whitelist includes the user task poll function and
`embassy_time::timer::{impl#5}::poll`. The local verification stops after three
user-task polls and prints `ardb-get-history-tree` plus validation JSON.

## Remote GDB / VS Code

Start the native host `gdbserver` manually:

```bash
./run_example_gdbserver.sh tick 1234
```

Then open the ARD repository root in VS Code and run `Run Extension -
embassy-std tick`. In the Extension Development Host window, use `Debug
embassy-std tick (ARD manual connect)`. The configuration is native x86-64 GDB;
it intentionally has no QEMU, RISC-V, or kernel setting. It does not connect to
`:1234`, source `attach.gdb`, load a whitelist, select a trace root, or continue
on the user's behalf.

For terminal GDB, generate the whitelist, manually connect to `target remote
:1234`, and then source `attach.gdb` (or use `verify_local_gdb.sh`). The attach
script inserts the ARD repository into GDB Python's `sys.path`, so no manual
`PYTHONPATH` export or GDB `sys.path` command is required.

## VS Code From The ARD Root

Open the repository root rather than requiring a separate testcase window:

```bash
code /home/user/RustDebug/rust-debugger-DA
```

Select `Run Extension - embassy-std tick` in the root Debug dropdown. This
opens an Extension Development Host with `testcases/embassy-std` as its
workspace. The root Tasks view also provides `embassy-std: build tick`,
`embassy-std: gen whitelist`, and `embassy-std: start gdbserver tick`.

## VS Code Async Inspector

Terminal 1:

```bash
cd /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std
./build_examples.sh tick
./gen_whitelist.sh tick
./run_example_gdbserver.sh tick 1234
```

In the Extension Development Host, run `Debug embassy-std tick (ARD manual
connect)`. Async Inspector opens with the ARD session. Click `Connect :1234`,
then enter the following in the Debug Console before continuing:

```gdb
source /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std/attach.gdb
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std/temp/poll_functions.txt
ardb-trace tick::__run_task::__run_task_inner_function::{async_fn#0}
continue
```

After a few seconds, pause or interrupt the target and run:

```gdb
ardb-get-history-tree
ardb-validate-history-tree
```

Finally click `History` in Async Inspector to display the runtime execution
graph.

For the tick workload, the expected graph is:

```text
tick::____embassy_main_task::{async_fn#0}
└── tick::__run_task::{async_fn#0}
    └── embassy_time::timer::{impl#5}::poll
```

## Candidate notes

- `tick`: preferred attach target; no device/network prerequisite and never
  exits on its own.
- `tick_cancel`: same timer/task shape but exits after roughly five seconds;
  useful for bounded debugger experiments.
- `net*`, `tcp_accept`, and `serial`: async but deferred because they require a
  TAP interface, network peer, or `/dev/ttyACM0` hardware.
