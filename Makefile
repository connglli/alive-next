# Build and test orchestration. docs/implementation.md holds the layout, and
# scripts/depman.sh owns everything about the toolchain, including the pins.
#
# One knob matters: TOOLCHAIN is where LLVM, alive2, llubi and llops are built,
# and every one of them is built from source against that one LLVM. It is set
# in config.jsonc, which is also what a run reads, and the environment
# overrides it for one command.
SHELL := /usr/bin/env bash
JOBS ?= $(shell nproc)
BUILD_TYPE ?= Release
DEPS := scripts/depman.sh
# depman.sh resolves this from the environment, then config.jsonc, then deps/,
# and the agent reads the same two places. Asking it here rather than repeating
# the rule is what keeps a build and a run pointed at one directory.
TOOLCHAIN := $(shell $(DEPS) toolchain)
PRECOMMIT := $(CURDIR)/.venv/bin/pre-commit
export TOOLCHAIN JOBS
# bun and uv are installed by their own installers, which put them here and
# leave PATH to the shell profile; a make run right after one of them installs
# would otherwise not see it.
export PATH := $(PATH):$(HOME)/.bun/bin:$(HOME)/.local/bin

LLOPS_BUILD := $(TOOLCHAIN)/llops/build

.PHONY: help install-deps deps-status deps-llvm deps-alive2 deps-llubi deps-bun \
        deps-js deps-uv deps-py deps-dev llops test-llops engine test-engine test examples \
        cert visualize test-scripts check clean

help:
	@echo "dependencies"
	@echo "  install-deps   build the toolchain and the host tools, then llops"
	@echo "  deps-status    report what is built, and where"
	@echo "  deps-<name>    build one of: llvm alive2 llubi bun js uv py dev"
	@echo "                 (dev adds the check tools and this clone's git hooks)"
	@echo "                 (FORCE=1 rebuilds one that is already there)"
	@echo ""
	@echo "build and test"
	@echo "  llops          build llops against the toolchain LLVM"
	@echo "  test-llops     run the llops tests"
	@echo "  engine         typecheck the engine"
	@echo "  test-engine    run the engine tests"
	@echo "  test           run every test suite"
	@echo "  examples       prove the example scenarios, into sessions/"
	@echo "                 (SCENARIO=<name> runs one of them)"
	@echo "  visualize      render SESSION=sessions/<id> as one HTML page"
	@echo "  cert           write the certificate SESSION=sessions/<id> earned"
	@echo "  check          run every hook over every file"
	@echo ""
	@echo "cleaning"
	@echo "  clean          remove the llops build tree"
	@echo ""
	@echo "TOOLCHAIN=$(TOOLCHAIN)"

# --- dependencies ------------------------------------------------------------
# llops comes last and is part of the set: it reads and writes the same IR as
# alive-tv and llubi, so it belongs to the same toolchain and is built with it.
install-deps:
	@$(DEPS) install
	@$(MAKE) --no-print-directory llops

deps-status:
	@$(DEPS) status

deps-llvm deps-alive2 deps-llubi deps-bun deps-js deps-uv deps-py deps-dev:
	@$(DEPS) $(patsubst deps-%,%,$@)

# --- llops -------------------------------------------------------------------
# llops links the LLVM alive-tv and llubi link, which is the toolchain's, never
# whatever CMake finds first: a system LLVM builds an llops that prints a
# dialect the checkers do not read. It builds inside the toolchain for the same
# reason, so which LLVM a binary belongs to is visible from where it sits.
llops:
	@cmakedir="$$($(DEPS) llvm-cmakedir)" && \
	  cmake -S llops -B $(LLOPS_BUILD) -G Ninja \
	    -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DLLVM_DIR="$$cmakedir"
	ninja -C $(LLOPS_BUILD) -j$(JOBS)
	@echo "llops built at $(LLOPS_BUILD)/llops"

test-llops: llops
	LLOPS=$(LLOPS_BUILD)/llops python3 llops/test/llops_test.py

# --- engine ------------------------------------------------------------------
# Bun runs TypeScript directly, so building the engine is typechecking it.
engine: deps-js
	cd engine && bun run check

# LLOPS names what was just built, so the suite tests this tree rather than
# whatever the configuration points at.
test-engine: deps-js
	cd engine && LLOPS=$(LLOPS_BUILD)/llops bun test

# The scenarios, run for real: each leaves a session directory behind, which is
# what the visualizer and the certificate checker read.
examples: deps-js
	cd engine && bun run examples $(SCENARIO)

# The certificate a verified session earned, written into the session.
cert: deps-js
	@test -n "$(SESSION)" || { echo "usage: make cert SESSION=sessions/<id>"; exit 2; }
	cd engine && bun run cert ../$(SESSION)

# --- scripts -----------------------------------------------------------------
# SESSION names a directory under sessions/; the page lands beside its
# trajectory.
visualize:
	@test -n "$(SESSION)" || { echo "usage: make visualize SESSION=sessions/<id>"; exit 2; }
	python3 scripts/visualize.py $(SESSION)

# check.py replays a certificate with alive-tv and llops and nothing of ours,
# so its tests build packages and bend them rather than running the framework.
test-scripts:
	python3 scripts/visualize_test.py
	python3 scripts/check_test.py

# --- everything --------------------------------------------------------------
test: test-llops test-engine test-scripts

# .pre-commit-config.yaml is the one place that says what is checked and with
# which upstream tool. The hook sees staged files; this sweeps the whole tree.
check: deps-dev engine
	@$(PRECOMMIT) run --all-files

clean:
	rm -rf $(LLOPS_BUILD)
