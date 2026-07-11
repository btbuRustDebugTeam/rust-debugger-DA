# Source this file after connecting GDB to the no_external_runtime target.
# It installs ARD commands and leaves whitelist loading, tracing, and continue
# as explicit manual steps.
set pagination off
set confirm off
set debuginfod enabled off
set python print-stack full

python
import os
import sys
os.environ["ARD_NO_EXTERNAL_RUNTIME_SINGLE_ROOT"] = "1"
ard_root = "/home/user/RustDebug/rust-debugger-DA"
if ard_root not in sys.path:
    sys.path.insert(0, ard_root)
end

python import async_rust_debugger

echo \n[no_external_runtime] ARD commands installed.\n
echo [no_external_runtime] Manual next steps:\n
echo   ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/no_external_runtime/temp/poll_functions.txt\n
echo   ardb-trace no_runtime_futures::async_coordinator::{async_fn#0}\n
echo   continue\n
echo   ardb-get-history-tree\n
echo   ardb-validate-history-tree\n
