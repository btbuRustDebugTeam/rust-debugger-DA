SHELL := /bin/bash

.PHONY: all env check-rust install-rust check-ddbug install-ddbug

all: env

env: check-rust check-ddbug

check-rust:
	@if ! command -v rustc >/dev/null 2>&1; then \
		echo "Rust not found — installing via rustup..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh; \
		echo "After install, run 'source $$HOME/.cargo/env' or restart your shell to have cargo in PATH."; \
	else \
		echo "Rust is installed: $$(rustc --version)"; \
	fi

# Usage: make compile TESTCASE=<testcase-name>
compile:
	@if [ -z "$(TESTCASE)" ]; then \
		echo "Usage: make compile TESTCASE=<testcase-name>"; \
		exit 1; \
	fi
	cd testcases/$(TESTCASE) && cargo build

clean:
	@if [ -z "$(TESTCASE)" ]; then \
		echo "Usage: make clean TESTCASE=<testcase-name>"; \
		exit 1; \
	fi
	cd testcases/$(TESTCASE) && cargo clean

clean-all:
	cd testcases/minimal && cargo clean
	cd testcases/no_external_runtime && cargo clean

# Usage: make debug TESTCASE=<testcase-name>
debug:
	@if [ -z "$(TESTCASE)" ]; then \
		echo "Usage: make debug TESTCASE=<testcase-name>"; \
		exit 1; \
	fi
	cd testcases/$(TESTCASE) && cargo build && \
	gdb target/debug/$(TESTCASE)