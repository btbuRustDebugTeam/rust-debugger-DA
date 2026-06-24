# Source this file after manually connecting to the remote target.
# It installs ARD commands only; it never loads a whitelist, selects a trace
# root, connects a target, or continues execution.
set pagination off
set confirm off
set debuginfod enabled off
set python print-stack full

python
import sys
ard_root = "/home/user/RustDebug/rust-debugger-DA"
if ard_root not in sys.path:
    sys.path.insert(0, ard_root)
end

python import async_rust_debugger

echo \n[embassy-std] ARD commands installed.\n
echo [embassy-std] Manual next steps:\n
echo   ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/embassy-std/temp/poll_functions.txt\n
echo   ardb-trace tick::__run_task::__run_task_inner_function::{async_fn#0}\n
echo   continue\n
echo   interrupt\n
echo   ardb-get-history-tree\n
echo   ardb-validate-history-tree\n
