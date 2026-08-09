#!/usr/bin/env bash
# Provision and inspect what alive-next builds and runs against: the LLVM
# toolchain, and the host tools (bun with the JS packages, uv with the Python
# ones).
#
# alive-tv, llubi and llops all parse and print LLVM IR, and they mean the same
# thing by a module only when they are built against the same LLVM. So there is
# no supported way to mix them: a distribution's alive2, a system LLVM, or a
# binary from someone else's checkout is a different dialect, and the failures
# it produces look like search failures rather than build mistakes. Everything
# LLVM-based is therefore built from source, from the pins below, against one
# LLVM.
#
# TOOLCHAIN is where that build lives, and it defaults to deps/ inside the
# repository. It is a knob because one toolchain can serve several checkouts
# and building another costs an hour. Its layout is the contract the agent
# reads as well, so it is stated here and in docs/implementation.md and
# nowhere else:
#
#   $TOOLCHAIN/llvm-project/build/bin/llvm-config
#   $TOOLCHAIN/alive2/build/alive-tv
#   $TOOLCHAIN/llubi-legacy/build/llubi
#   $TOOLCHAIN/llops/build/llops
#   $TOOLCHAIN/toolchain.json     what was built, from which revisions
#
# One rule decides whether anything happens: a dependency counts as installed
# when its have_* check passes, so every subcommand is idempotent and a build
# that already fits is left alone. FORCE=1 builds regardless.
#
# Usage: scripts/depman.sh <install|status|toolchain|llvm-cmakedir|llvm|alive2|llubi|bun|js|uv|py|dev>
#
# TOOLCHAIN, JOBS and FORCE are the environment knobs.
set -euo pipefail

# --- Pinned refs -------------------------------------------------------------
# Upgrading a dependency is one line here and one reviewed diff, and it means
# rebuilding everything below it: the pins are one toolchain, not three.
#
# llubi is the out-of-tree interpreter, not the one now living in llvm/tools.
# The in-tree copy is a newer rewrite and is not stable yet; the original is
# what the counterexample replay is built on.
LLVM_REPO=https://github.com/llvm/llvm-project.git
LLVM_PIN=llvmorg-22.1.0
ALIVE2_REPO=https://github.com/AliveToolkit/alive2.git
ALIVE2_PIN=0dc2be5f04ccb61caebb909a610968cb2348f196
LLUBI_REPO=https://github.com/dtcxzyw/llvm-ub-aware-interpreter.git
LLUBI_PIN=9798ef7520061b89485475c9739a8c578528f3f7

# The release a tool has to report to count as built against our LLVM.
LLVM_VERSION=${LLVM_PIN#llvmorg-}

# --- Layout ------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Which toolchain this is about: the environment, then config.jsonc, then
# deps/. The agent resolves it the same way, and it asks this script rather
# than reading it twice, because a build and a run that disagree about where
# the binaries are is the one mistake this file cannot catch.
configured_toolchain() {
  local file="$ROOT/config.jsonc" path=""
  [ -f "$file" ] &&
    path=$(sed -nE 's|^[[:space:]]*"toolchain"[[:space:]]*:[[:space:]]*"(.*)".*|\1|p' "$file" |
      head -1)
  echo "${path:-deps}"
}
TOOLCHAIN="${TOOLCHAIN:-$(configured_toolchain)}"
case "$TOOLCHAIN" in /*) ;; *) TOOLCHAIN="$ROOT/$TOOLCHAIN" ;; esac
JOBS="${JOBS:-$(nproc)}"
LLVM_SRC="$TOOLCHAIN/llvm-project"
LLVM_BUILD="$LLVM_SRC/build"
ALIVE2_SRC="$TOOLCHAIN/alive2"
ALIVE2_BUILD="$ALIVE2_SRC/build"
LLUBI_SRC="$TOOLCHAIN/llubi-legacy"
LLUBI_BUILD="$LLUBI_SRC/build"
LLOPS_BUILD="$TOOLCHAIN/llops/build"
STAMP="$TOOLCHAIN/toolchain.json"
AGENT="$ROOT/agent"
VENV="$ROOT/.venv"

# --- Output ------------------------------------------------------------------
say() { printf '\033[1;34m[deps]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deps]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[deps]\033[0m %s\n' "$*" >&2
  exit 1
}

# A prerequisite we do not install: the message says how to get it.
require() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not on PATH. $2"
}

# A host tool: on PATH, or where its own installer puts it. bun and uv are
# installed the way their instructions say, so they land in the same place for
# us as for anything else on the machine, and the second lookup is for the
# shell that installed one and has not picked up its PATH yet.
find_tool() {
  local name=$1 candidate
  command -v "$name" 2>/dev/null && return 0
  for candidate in "$HOME/.bun/bin/$name" "$HOME/.local/bin/$name"; do
    [ -x "$candidate" ] && {
      echo "$candidate"
      return 0
    }
  done
  return 1
}

# The LLVM release a tool reports, which is how a binary says which toolchain
# it belongs to. Every one of them prints LLVM's own version banner.
tool_llvm_version() {
  "$1" --version 2>/dev/null | sed -nE 's/.*LLVM version ([0-9.]+).*/\1/p' | head -1
}

# A source tree at the revision we pin, cloned if it is not there yet. The
# fetch is what lets a pin move forward without a fresh clone.
checkout() {
  local dir=$1 repo=$2 ref=$3
  require git "Install it with your package manager."
  if [ ! -d "$dir/.git" ]; then
    say "cloning $(basename "$dir")"
    git clone "$repo" "$dir"
  fi
  git -C "$dir" rev-parse --verify --quiet "$ref^{commit}" >/dev/null ||
    git -C "$dir" fetch --quiet --tags origin
  say "checking out $(basename "$dir") at $ref"
  git -C "$dir" checkout --quiet "$ref"
}

# What a source tree is actually at, for the stamp the agent records.
revision() { git -C "$1" rev-parse HEAD 2>/dev/null || echo unknown; }

builders() {
  require cmake "Install it with your package manager."
  require ninja "Install it with your package manager (package 'ninja-build')."
}

# --- LLVM --------------------------------------------------------------------
# The flags are not preferences. alive2 refuses to configure without RTTI; the
# assertions and the ABI breaking checks are what make a malformed module say
# so instead of misbehaving later; and shared libraries keep four binaries from
# costing several gigabytes each. Targets and projects do not affect what a
# module means, so only X86 is built, and LLVM_TARGETS and LLVM_PROJECTS are
# there for a machine that wants more.
have_llvm() {
  local cfg="$LLVM_BUILD/bin/llvm-config" version
  [ -x "$cfg" ] || return 1
  version=$("$cfg" --version 2>/dev/null) || return 1
  [ "$version" = "$LLVM_VERSION" ] || return 1
  # The two an existing build can plausibly have wrong, and both change what
  # the tools do with a module: alive2 will not configure without RTTI, and
  # without assertions a malformed module goes unremarked instead of loudly
  # wrong.
  [ "$("$cfg" --has-rtti 2>/dev/null)" = YES ] || return 1
  [ "$("$cfg" --assertion-mode 2>/dev/null)" = ON ] || return 1
  echo "$version at $cfg"
}

install_llvm() {
  builders
  checkout "$LLVM_SRC" "$LLVM_REPO" "$LLVM_PIN"
  # Linking a shared-library LLVM is where GNU ld spends its time and memory,
  # so lld is used when the machine has one.
  local linker=()
  command -v ld.lld >/dev/null 2>&1 && linker=(-DLLVM_USE_LINKER=lld)
  cmake -S "$LLVM_SRC/llvm" -B "$LLVM_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=ON \
    -DLLVM_ENABLE_RTTI=ON \
    -DLLVM_ENABLE_ASSERTIONS=ON \
    -DLLVM_ABI_BREAKING_CHECKS=WITH_ASSERTS \
    -DLLVM_ENABLE_PROJECTS="${LLVM_PROJECTS:-llvm}" \
    -DLLVM_TARGETS_TO_BUILD="${LLVM_TARGETS:-X86}" \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    "${linker[@]}"
  say "building llvm with $JOBS jobs; this is the slow one, roughly an hour"
  ninja -C "$LLVM_BUILD" -j"$JOBS"
}

# --- alive2 ------------------------------------------------------------------
have_alive2() {
  local bin="$ALIVE2_BUILD/alive-tv" version
  [ -x "$bin" ] || return 1
  version=$(tool_llvm_version "$bin")
  [ "$version" = "$LLVM_VERSION" ] || return 1
  echo "$bin (LLVM $version)"
}

install_alive2() {
  builders
  # alive2 needs Z3 4.8.5 or newer and CMake decides whether it has one. This
  # is only a friendlier way to say the same thing first, so it warns rather
  # than refusing: a machine may keep Z3 somewhere this does not look.
  [ -f /usr/include/z3.h ] || [ -f /usr/local/include/z3.h ] ||
    pkg-config --exists z3 2>/dev/null ||
    warn "no Z3 headers found where they usually are. alive2 needs them, so if
       the configure below fails, install them, for example with
       sudo apt install libz3-dev"
  ensure llvm 0
  checkout "$ALIVE2_SRC" "$ALIVE2_REPO" "$ALIVE2_PIN"

  # BUILD_LLVM_UTILS is what makes alive2 build alive-tv at all. The heavier
  # BUILD_TV additionally builds the opt plugin, which we do not use.
  say "building alive-tv against LLVM $LLVM_VERSION"
  cmake -S "$ALIVE2_SRC" -B "$ALIVE2_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_LLVM_UTILS=1 \
    -DLLVM_DIR="$LLVM_BUILD/lib/cmake/llvm"
  ninja -C "$ALIVE2_BUILD" -j"$JOBS" alive-tv
}

# --- llubi -------------------------------------------------------------------
have_llubi() {
  local bin="$LLUBI_BUILD/llubi" version
  [ -x "$bin" ] || return 1
  version=$(tool_llvm_version "$bin")
  [ "$version" = "$LLVM_VERSION" ] || return 1
  echo "$bin (LLVM $version)"
}

install_llubi() {
  builders
  ensure llvm 0
  checkout "$LLUBI_SRC" "$LLUBI_REPO" "$LLUBI_PIN"
  say "building llubi against LLVM $LLVM_VERSION"
  cmake -S "$LLUBI_SRC" -B "$LLUBI_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_DIR="$LLVM_BUILD/lib/cmake/llvm"
  ninja -C "$LLUBI_BUILD" -j"$JOBS" llubi
}

# --- llops -------------------------------------------------------------------
# Part of the toolchain, but built from this repository, so the Makefile owns
# building it and this only reports it: a toolchain without llops is not one a
# run can use.
have_llops() {
  local bin="$LLOPS_BUILD/llops" version
  [ -x "$bin" ] || return 1
  version=$("$bin" version 2>/dev/null | sed -nE 's/.*LLVM ([0-9.]+).*/\1/p')
  [ "$version" = "$LLVM_VERSION" ] || return 1
  echo "$bin (LLVM $version)"
}

# --- bun and the JS packages -------------------------------------------------
have_bun() {
  local bin
  bin=$(find_tool bun) || return 1
  echo "$bin ($("$bin" --version 2>/dev/null))"
}

install_bun() {
  require curl "Install it with your package manager."
  say "installing bun where its installer puts it"
  bash -c "$(curl -fsSL https://bun.sh/install)"
}

# The JS packages belong to the agent, which is the only thing written in it,
# so the manifest and the tree both live in agent/.
have_js() {
  [ -d "$AGENT/node_modules" ] || return 1
  echo "$AGENT/node_modules"
}

install_js() {
  ensure bun 0
  say "installing the agent's JS packages"
  (cd "$AGENT" && "$(find_tool bun)" install)
}

# --- uv and the Python environment -------------------------------------------
have_uv() {
  local bin
  bin=$(find_tool uv) || return 1
  echo "$bin ($("$bin" --version 2>/dev/null))"
}

install_uv() {
  require curl "Install it with your package manager."
  say "installing uv where its installer puts it"
  bash -c "$(curl -LsSf https://astral.sh/uv/install.sh)"
}

# --- the Python packages -----------------------------------------------------
# One environment, two owners: `py` is what a run needs and `dev` is what a
# contributor needs on top. Both sync inexactly, so neither removes what the
# other installed, and `uv sync --check` is what decides either is in place.
# uv provides the interpreter as well, so python3 is not a prerequisite here.
uv_sync() {
  (cd "$ROOT" && env -u VIRTUAL_ENV "$(find_tool uv)" sync --inexact "$@")
}

have_py() {
  find_tool uv >/dev/null || return 1
  # The environment can satisfy an empty dependency list without existing, so
  # the interpreter is checked before the packages are.
  [ -x "$VENV/bin/python" ] || return 1
  uv_sync --no-dev --check >/dev/null 2>&1 || return 1
  echo "$VENV ($("$VENV/bin/python" --version 2>&1))"
}

install_py() {
  ensure uv 0
  say "syncing the Python packages from uv.lock"
  uv_sync --no-dev
}

# --- the development environment ---------------------------------------------
# What a contributor needs and a run does not: the tools that check the tree,
# and the git hooks that run them. The dev packages are a superset of the
# runtime ones, so this sync covers both.
have_dev() {
  find_tool uv >/dev/null || return 1
  [ -x "$VENV/bin/python" ] || return 1
  uv_sync --check >/dev/null 2>&1 || return 1
  grep -q pre-commit "$(git -C "$ROOT" rev-parse --git-path hooks/pre-commit)" 2>/dev/null ||
    return 1
  echo "$VENV ($("$VENV/bin/python" --version 2>&1)), git hooks installed"
}

install_dev() {
  ensure uv 0
  say "syncing the development packages from uv.lock"
  uv_sync
  say "installing the git hooks"
  (cd "$ROOT" && "$VENV/bin/pre-commit" install --hook-type pre-commit --hook-type commit-msg)
}

# --- Driver ------------------------------------------------------------------
DEP_NAMES=(llvm alive2 llubi bun js uv py dev)

# ensure <name> <force>. Force is passed rather than read from the environment
# so that it applies to the dependency that was asked for and not to the ones
# it pulls in: reinstalling alive2 must not rebuild LLVM.
ensure() {
  local name=$1 force=$2 desc
  if [ "$force" != 1 ] && desc=$("have_$name"); then
    say "$name: present, $desc"
    return
  fi
  "install_$name"
  desc=$("have_$name") || die "$name: still not usable after installing it"
  say "$name: installed, $desc"
}

status() {
  local name desc missing=0
  printf 'toolchain: %s\n\n' "$TOOLCHAIN"
  for name in "${DEP_NAMES[@]}"; do
    if desc=$("have_$name"); then
      printf '  \033[1;32m%-8s\033[0m %s\n' "$name" "$desc"
    else
      printf '  \033[1;31m%-8s\033[0m missing\n' "$name"
      missing=1
    fi
  done
  if desc=$(have_llops); then
    printf '  \033[1;32m%-8s\033[0m %s\n' llops "$desc"
  else
    printf '  \033[1;31m%-8s\033[0m missing, run '"'"'make llops'"'"'\n' llops
    missing=1
  fi
  printf '\npins: llvm %s, alive2 %s, llubi %s\n' "$LLVM_PIN" "$ALIVE2_PIN" "$LLUBI_PIN"
  [ "$missing" = 0 ] || printf "run 'make install-deps' to build what is missing\n"
}

# What was built and from what, written where the agent looks for it. A run
# records this, so a trajectory says which toolchain produced it, and a
# toolchain nobody can name is one nobody can reproduce.
stamp() {
  cat >"$STAMP" <<JSON
{
  "llvm": { "pin": "$LLVM_PIN", "revision": "$(revision "$LLVM_SRC")" },
  "alive2": { "pin": "$ALIVE2_PIN", "revision": "$(revision "$ALIVE2_SRC")" },
  "llubi": { "pin": "$LLUBI_PIN", "revision": "$(revision "$LLUBI_SRC")" },
  "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  say "wrote $STAMP"
}

# Where CMake finds the LLVM llops builds against: ours, and only ours. A
# system LLVM would build an llops that prints a dialect alive-tv does not
# read, which is the failure this whole file exists to prevent.
llvm_cmakedir() {
  have_llvm >/dev/null ||
    die "no LLVM at $LLVM_BUILD. Run 'make install-deps' (TOOLCHAIN=$TOOLCHAIN)."
  echo "$LLVM_BUILD/lib/cmake/llvm"
}

case "${1:-status}" in
  install)
    for name in "${DEP_NAMES[@]}"; do ensure "$name" "${FORCE:-0}"; done
    stamp
    say "done. The toolchain is $TOOLCHAIN; name it in config.jsonc as \"toolchain\"."
    ;;
  status) status ;;
  toolchain) echo "$TOOLCHAIN" ;;
  llvm-cmakedir) llvm_cmakedir ;;
  llvm | alive2 | llubi | bun | js | uv | py | dev)
    ensure "$1" "${FORCE:-0}"
    case "$1" in llvm | alive2 | llubi) stamp ;; esac
    ;;
  *)
    die "usage: $(basename "$0") <install|status|toolchain|llvm-cmakedir|${DEP_NAMES[*]}>"
    ;;
esac
