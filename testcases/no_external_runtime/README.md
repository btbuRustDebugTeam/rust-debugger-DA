# no_external_runtime ARD testcase

This testcase exercises Rust futures without an external async runtime. It is a
native host binary intended for ARD local launch or GDB remote attach.

## Build

```sh
cargo build
```

## Generate whitelist

```sh
./gen_whitelist.sh
```

The script writes:

```text
temp/poll_functions.txt
```

## GDB remote attach flow

Terminal 1:

```sh
./run_gdbserver.sh 1234
```

Terminal 2:

```gdb
gdb -q target/debug/no_runtime_futures
target remote :1234
source attach.gdb
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/no_external_runtime/temp/poll_functions.txt
ardb-trace no_runtime_futures::async_coordinator::{async_fn#0}
continue
ardb-get-history-tree
```

## VS Code

Open this directory as the workspace and use one of:

```text
Debug no_external_runtime (ARD)
Attach no_external_runtime :1234 (ARD)
```

For attach mode, start `./run_gdbserver.sh 1234` first, then start the attach
debug configuration.
