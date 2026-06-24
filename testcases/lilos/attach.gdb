# Source after connecting gdb-multiarch to the LILO LM3S GDB stub.
set pagination off
set confirm off
set debuginfod enabled off
set python print-stack full
directory /home/user/lilos/testsuite/src

python
import sys
ard_root = "/home/user/RustDebug/rust-debugger-DA"
if ard_root not in sys.path:
    sys.path.insert(0, ard_root)
end

python import async_rust_debugger

echo \n[lilos] ARD commands installed.\n
echo [lilos] source directory: /home/user/lilos/testsuite/src\n
echo [lilos] Manual next steps:\n
echo   ardb-load-whitelist /home/user/RustDebug/rust-debugger-DA/testcases/lilos/temp/poll_functions.txt\n
echo   ardb-trace lilos_testsuite::run_test_suite\n
echo   continue\n
echo   interrupt\n
echo   ardb-get-history-tree\n
echo   ardb-validate-history-tree\n
