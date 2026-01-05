# frequently used commands to help developers of this project

if [ "$1" = "compile-tests" ]; then
    case "$2" in
        minimal)
            echo "Compiling testcases (minimal)..."
            cd testcases/minimal
            cargo build
            ;;
        no_external_runtime)
            echo "Compiling testcases (no_external_runtime)..."
            cd testcases/no_external_runtime
            cargo build
            ;;
        *)
            echo "Usage: $0 compile-tests {minimal|no_external_runtime}" >&2
            exit 2
            ;;
    esac
fi