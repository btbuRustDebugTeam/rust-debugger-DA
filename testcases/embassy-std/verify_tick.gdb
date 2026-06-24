set pagination off
set confirm off
set debuginfod enabled off
set python print-stack full

start
python import async_rust_debugger
ardb-gen-whitelist
ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std/temp/poll_functions.txt
ardb-trace 'tick::__run_task::__run_task_inner_function::{async_fn#0}'

set $root_hits = 0
break 'tick::__run_task::__run_task_inner_function::{async_fn#0}'
commands
  silent
  set $root_hits = $root_hits + 1
  printf "[embassy-std] tick async root hit %d\n", $root_hits
  if $root_hits >= 3
    echo \n===== ARD history tree =====\n
    ardb-get-history-tree
    echo \n===== ARD history validation =====\n
    ardb-validate-history-tree
    quit
  end
  continue
end
continue
