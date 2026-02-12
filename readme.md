# async-rust-debugger

## 总体目标
1、将跨特权级调试和异步函数调试功能整合在一起
2、异步调试能力：断点后显示当前的函数调用栈（包括异步函数和同步函数）；基于白名单的函数调用关系数据输出、绘制火焰图
3、通用的调试能力，支持多种rust操作系统和rust运行时

## usage

```sh
make env
# to avoid recompiling you can use just-debug
make debug TESTCASE=minimal
(gdb) ardb-gen-whitelist
```
in `temp/poll_functions.txt` you can add sync functions or delete functions you don't want to trace.

for example, to trace testcases/minimal:
```
0 minimal::another_branch::{async_fn#0}
1 minimal::async_fn_leaf::{async_fn#0}
2 minimal::main::{async_block#0}
3 minimal::nonleaf::{async_fn#0}
4 minimal::{impl#0}::poll
5 minimal::block_on*
6 minimal::sync_b
7 minimal::sync_a
```
you can add `*` at the end of a function name to include all its prefixes.
then in `gdb` run
```sh
(gdb) ardb-load-whitelist
(gdb) ardb-trace the function you want to start tracing from
(gdb) run
```

example output

```
@chenzhiy2001 ➜ /workspaces/codespaces-blank (main) $ make just-debug TESTCASE=minimal
cd testcases/minimal && \
PYTHONPATH=/workspaces/codespaces-blank \
ASYNC_RUST_DEBUGGER_TEMP_DIR=/workspaces/codespaces-blank/temp \
gdb -ex "python import async_rust_debugger" target/debug/minimal
GNU gdb (Ubuntu 15.0.50.20240403-0ubuntu1) 15.0.50.20240403-git
Copyright (C) 2024 Free Software Foundation, Inc.
License GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
Type "show copying" and "show warranty" for details.
This GDB was configured as "x86_64-linux-gnu".
Type "show configuration" for configuration details.
For bug reporting instructions, please see:
<https://www.gnu.org/software/gdb/bugs/>.
Find the GDB manual and other documentation resources online at:
    <http://www.gnu.org/software/gdb/documentation/>.

For help, type "help".
--Type <RET> for more, q to quit, c to continue without paging--c
Type "apropos word" to search for commands related to "word"...
Reading symbols from target/debug/minimal...
warning: Missing auto-load script at offset 0 in section .debug_gdb_scripts
of file /workspaces/codespaces-blank/testcases/minimal/target/debug/minimal.
Use `info auto-load python-scripts [REGEXP]' to list them.
[ARD] installed. Commands: ardb-trace, ardb-reset, ardb-load-whitelist, ardb-gen-whitelist
(gdb) ardb-load-whitelist 
[ARD] whitelist loaded: exact=7 prefix=1 from /workspaces/codespaces-blank/temp/poll_functions.txt
(gdb) ardb-trace minimal::nonleaf::{async_fn#0}
Breakpoint 1 at 0x163e9: file src/main.rs, line 31.
[ARD] trace root: minimal::nonleaf::{async_fn#0}
(gdb) run
Starting program: /workspaces/codespaces-blank/testcases/minimal/target/debug/minimal 
[Thread debugging using libthread_db enabled]
Using host libthread_db library "/lib/x86_64-linux-gnu/libthread_db.so.1".
sync_a(1)
sync_a(1)
sync_b(2)
sync_a(4)
sync_a(1)
sync_b(2)
leaf: 21
[ARD] whitelist addrs: 7/7 resolved (exact), prefix=1
[ARD] coro#1 new: minimal::nonleaf::{async_fn#0} @ 0x7fffffffc674
[ARD] poll[coro#1 poll#1] minimal::nonleaf::{async_fn#0}
[ARD] call-sites: 13
[ARD] call[coro#1 poll#1] minimal::nonleaf::{async_fn#0} -> minimal::async_fn_leaf::{async_fn#0}
[ARD]   coro#2 new: minimal::async_fn_leaf::{async_fn#0} @ 0x7fffffffc680
[ARD]   poll[coro#2 poll#1] minimal::async_fn_leaf::{async_fn#0}
[ARD]   call-sites: 13
[ARD]   call[coro#2 poll#1] minimal::async_fn_leaf::{async_fn#0} -> minimal::sync_a
sync_a(2)
[ARD]   call[coro#2 poll#1] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn#0}
[ARD]     coro#3 new: minimal::another_branch::{async_fn#0} @ 0x7fffffffc68c
[ARD]     poll[coro#3 poll#1] minimal::another_branch::{async_fn#0}
[ARD]     call-sites: 7
[ARD]     call[coro#3 poll#1] minimal::another_branch::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]       coro#4 new: minimal::{impl#0}::poll @ 0x7fffffffc690
[ARD]       poll[coro#4 poll#1] minimal::{impl#0}::poll
[ARD]       call-sites: 7
[ARD]       call[coro#4 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(2)
[ARD] poll[coro#1 poll#2] minimal::nonleaf::{async_fn#0}
[ARD] awa[coro#1 poll#2] minimal::nonleaf::{async_fn#0} -> minimal::async_fn_leaf::{async_fn_env#0}
[ARD] call[coro#1 poll#2] minimal::nonleaf::{async_fn#0} -> minimal::async_fn_leaf::{async_fn#0}
[ARD]   poll[coro#2 poll#2] minimal::async_fn_leaf::{async_fn#0}
[ARD]   awa[coro#2 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn_env#0}
[ARD]   call[coro#2 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn#0}
[ARD]     poll[coro#3 poll#2] minimal::another_branch::{async_fn#0}
[ARD]     awa[coro#3 poll#2] minimal::another_branch::{async_fn#0} -> minimal::Manual
[ARD]     call[coro#3 poll#2] minimal::another_branch::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]       poll[coro#4 poll#2] minimal::{impl#0}::poll
[ARD]       call[coro#4 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(3)
[ARD]     call[coro#3 poll#2] minimal::another_branch::{async_fn#0} -> minimal::sync_a
sync_a(6)
[ARD]   call[coro#2 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::block_on
[ARD]     coro#5 new: minimal::{impl#0}::poll @ 0x7fffffffc3f0
[ARD]     poll[coro#5 poll#1] minimal::{impl#0}::poll
[ARD]     call[coro#5 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(2)
[ARD]     poll[coro#5 poll#2] minimal::{impl#0}::poll
[ARD]     call[coro#5 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(3)
[ARD] call[coro#1 poll#2] minimal::nonleaf::{async_fn#0} -> minimal::sync_b
sync_b(30)
[ARD] call[coro#1 poll#2] minimal::nonleaf::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]   coro#6 new: minimal::{impl#0}::poll @ 0x7fffffffc684
[ARD]   poll[coro#6 poll#1] minimal::{impl#0}::poll
[ARD]   call[coro#6 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(2)
[ARD] poll[coro#1 poll#3] minimal::nonleaf::{async_fn#0}
[ARD] awa[coro#1 poll#3] minimal::nonleaf::{async_fn#0} -> minimal::Manual
[ARD] call[coro#1 poll#3] minimal::nonleaf::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]   poll[coro#6 poll#2] minimal::{impl#0}::poll
[ARD]   call[coro#6 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(3)
nonleaf: 66
[ARD] coro#7 new: minimal::async_fn_leaf::{async_fn#0} @ 0x7fffffffc6fc
[ARD] poll[coro#7 poll#1] minimal::async_fn_leaf::{async_fn#0}
[ARD] call[coro#7 poll#1] minimal::async_fn_leaf::{async_fn#0} -> minimal::sync_a
sync_a(3)
[ARD] call[coro#7 poll#1] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn#0}
[ARD]   coro#8 new: minimal::another_branch::{async_fn#0} @ 0x7fffffffc708
[ARD]   poll[coro#8 poll#1] minimal::another_branch::{async_fn#0}
[ARD]   call[coro#8 poll#1] minimal::another_branch::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]     coro#9 new: minimal::{impl#0}::poll @ 0x7fffffffc70c
[ARD]     poll[coro#9 poll#1] minimal::{impl#0}::poll
[ARD]     call[coro#9 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(3)
[ARD] poll[coro#7 poll#2] minimal::async_fn_leaf::{async_fn#0}
[ARD] awa[coro#7 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn_env#0}
[ARD] call[coro#7 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::another_branch::{async_fn#0}
[ARD]   poll[coro#8 poll#2] minimal::another_branch::{async_fn#0}
[ARD]   awa[coro#8 poll#2] minimal::another_branch::{async_fn#0} -> minimal::Manual
[ARD]   call[coro#8 poll#2] minimal::another_branch::{async_fn#0} -> minimal::{impl#0}::poll
[ARD]     poll[coro#9 poll#2] minimal::{impl#0}::poll
[ARD]     call[coro#9 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(4)
[ARD]   call[coro#8 poll#2] minimal::another_branch::{async_fn#0} -> minimal::sync_a
sync_a(8)
[ARD] call[coro#7 poll#2] minimal::async_fn_leaf::{async_fn#0} -> minimal::block_on
[ARD]   coro#10 new: minimal::{impl#0}::poll @ 0x7fffffffc430
[ARD]   poll[coro#10 poll#1] minimal::{impl#0}::poll
[ARD]   call[coro#10 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(3)
[ARD]   poll[coro#10 poll#2] minimal::{impl#0}::poll
[ARD]   call[coro#10 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(4)
sync_b(39)
block: 78
[ARD] coro#11 new: minimal::{impl#0}::poll @ 0x7fffffffc780
[ARD] poll[coro#11 poll#1] minimal::{impl#0}::poll
[ARD] call[coro#11 poll#1] minimal::{impl#0}::poll -> minimal::sync_a
sync_a(4)
[ARD] poll[coro#11 poll#2] minimal::{impl#0}::poll
[ARD] call[coro#11 poll#2] minimal::{impl#0}::poll -> minimal::sync_b
sync_b(5)
manual: 10
[Inferior 1 (process 16230) exited normally]
(gdb) q
```

## todo
- modularization
