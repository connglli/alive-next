# Build and test orchestration. docs/implementation.md holds the layout, and
# scripts/deps.sh owns everything about the external tools, including the pins.
#
# Two knobs matter: PREFIX is where the external tools live and where our own
# binaries are installed, and BUILD is where build trees go. Both stay inside
# the repository, so nothing outside it is touched and `make clean-deps` is a
# plain remove.
SHELL := /usr/bin/env bash
PREFIX ?= $(CURDIR)/deps/prefix
BUILD ?= $(CURDIR)/build
JOBS ?= $(shell nproc)
BUILD_TYPE ?= Release
DEPS := scripts/deps.sh
PRECOMMIT := $(CURDIR)/.venv/bin/pre-commit
export PREFIX JOBS
# Our tools win over the system's for everything below.
export PATH := $(PREFIX)/bin:$(PATH)

LLOPS_BUILD := $(BUILD)/llops

.PHONY: help install-deps deps-status deps-llvm deps-alive2 deps-llubi deps-bun \
        deps-js deps-uv deps-py deps-dev llops test-llops agent test-agent test check \
        clean clean-deps

help:
	@echo "dependencies"
	@echo "  install-deps   install every external tool that is missing"
	@echo "  deps-status    report which tools are present, and where"
	@echo "  deps-<name>    install one of: llvm alive2 llubi bun js uv py dev"
	@echo "                 (dev adds the check tools and this clone's git hooks)"
	@echo "                 (FORCE=1 reinstalls one that is already there)"
	@echo ""
	@echo "build and test"
	@echo "  llops          build llops and install it into PREFIX/bin"
	@echo "  test-llops     run the llops tests"
	@echo "  agent          typecheck the agent"
	@echo "  test-agent     run the agent tests"
	@echo "  test           run every test suite"
	@echo "  check          run every hook over every file"
	@echo ""
	@echo "cleaning"
	@echo "  clean          remove our build trees"
	@echo "  clean-deps     remove deps/ and .venv: every external tool and the prefix"
	@echo ""
	@echo "PREFIX=$(PREFIX)"
	@echo "BUILD=$(BUILD)"

# --- dependencies ------------------------------------------------------------
install-deps:
	@$(DEPS) install

deps-status:
	@$(DEPS) status

deps-llvm deps-alive2 deps-llubi deps-bun deps-js deps-uv deps-py deps-dev:
	@$(DEPS) $(patsubst deps-%,%,$@)

# --- llops -------------------------------------------------------------------
# llops has to link the LLVM alive2 links, so the LLVM to build against is the
# one deps.sh resolves, never whatever CMake happens to find first.
llops:
	@cmakedir="$$($(DEPS) llvm-cmakedir)" && \
	  cmake -S llops -B $(LLOPS_BUILD) -G Ninja \
	    -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DLLVM_DIR="$$cmakedir"
	ninja -C $(LLOPS_BUILD) -j$(JOBS)
	@cmake --install $(LLOPS_BUILD) --prefix $(PREFIX) > /dev/null
	@echo "llops installed at $(PREFIX)/bin/llops"

test-llops: llops
	LLOPS=$(LLOPS_BUILD)/llops python3 llops/test/llops_test.py

# --- agent -------------------------------------------------------------------
# Bun runs TypeScript directly, so building the agent is typechecking it.
agent: deps-js
	cd agent && bun run check

# LLOPS names what was just built, so the suite tests this tree rather than
# whatever the configuration points at.
test-agent: deps-js
	cd agent && LLOPS=$(LLOPS_BUILD)/llops bun test

# --- everything --------------------------------------------------------------
test: test-llops test-agent

# .pre-commit-config.yaml is the one place that says what is checked and with
# which upstream tool. The hook sees staged files; this sweeps the whole tree.
check: deps-dev agent
	@$(PRECOMMIT) run --all-files

clean:
	rm -rf $(BUILD)

clean-deps:
	rm -rf $(CURDIR)/deps $(CURDIR)/.venv
