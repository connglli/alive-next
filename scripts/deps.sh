#!/usr/bin/env bash
# Provision and inspect the external tools alive-next builds and runs against:
# LLVM, alive2, llubi, bun with the JS packages, and uv with the Python ones.
#
# One rule decides whether anything happens: a dependency counts as installed
# when its have_* check passes, so every subcommand is idempotent and a copy
# that already fits is left alone. FORCE=1 installs regardless.
#
# Everything we install lands in PREFIX, so that one directory on PATH
# completes the environment and removing it undoes the installation. A tool
# that was already good enough stays where it was.
#
# Usage: scripts/deps.sh <install|status|llvm-cmakedir|llvm|alive2|llubi|bun|js|uv|py|dev>
#
# LLVM_CONFIG, PREFIX, JOBS and FORCE are the environment knobs.
set -euo pipefail

# --- Pinned refs -------------------------------------------------------------
# Upgrading a dependency is one line here and one reviewed diff. The pins share
# one LLVM: alive2 master builds against LLVM 22, and so does llubi.
#
# llubi is the out-of-tree interpreter, not the one now living in llvm/tools.
# The in-tree copy is a newer rewrite and is not stable yet; the original is
# what the counterexample replay is built on.
LLVM_PIN=llvmorg-22.1.8
ALIVE2_PIN=a68009c9e815
LLUBI_REPO=https://github.com/dtcxzyw/llvm-ub-aware-interpreter.git
LLUBI_PIN=4365dcfbc29bc692422194a1b007817e8c6f9a1a

LLVM_MAJOR=${LLVM_PIN#llvmorg-}
LLVM_MAJOR=${LLVM_MAJOR%%.*}

# --- Layout ------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/deps"
PREFIX="${PREFIX:-$DEPS/prefix}"
JOBS="${JOBS:-$(nproc)}"
LLVM_SRC="$DEPS/llvm-project"
LLVM_BUILD="$DEPS/llvm-build"
ALIVE2_SRC="$DEPS/alive2"
ALIVE2_BUILD="$DEPS/alive2-build"
LLUBI_SRC="$DEPS/llubi"
LLUBI_BUILD="$DEPS/llubi-build"
AGENT="$ROOT/agent"
VENV="$ROOT/.venv"
export PATH="$PREFIX/bin:$PATH"

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

# The first of these names that exists, ours before the system's.
find_tool() {
  local name
  for name in "$@"; do [ -x "$PREFIX/bin/$name" ] && {
    echo "$PREFIX/bin/$name"
    return 0
  }; done
  for name in "$@"; do command -v "$name" 2>/dev/null && return 0; done
  return 1
}

# The LLVM major an LLVM-based tool reports, or nothing when it does not say.
tool_llvm_major() {
  "$1" --version 2>/dev/null | sed -nE 's/.*LLVM version ([0-9]+).*/\1/p' | head -1
}

# The one place that decides which LLVM everything here uses. LLVM_CONFIG
# names a specific one, which is how a machine with several of them says so.
find_llvm_config() {
  if [ -n "${LLVM_CONFIG:-}" ]; then
    [ -x "$LLVM_CONFIG" ] || {
      warn "LLVM_CONFIG=$LLVM_CONFIG is not executable"
      return 1
    }
    echo "$LLVM_CONFIG"
    return 0
  fi
  find_tool llvm-config "llvm-config-$LLVM_MAJOR"
}

# --- LLVM --------------------------------------------------------------------
# llops and alive2 have to agree on the LLVM they link, so the major version is
# part of what makes an installation acceptable, as is RTTI, which alive2 needs.
have_llvm() {
  local cfg version
  cfg=$(find_llvm_config) || return 1
  version=$("$cfg" --version 2>/dev/null) || return 1
  [ "${version%%.*}" = "$LLVM_MAJOR" ] || return 1
  [ "$("$cfg" --has-rtti 2>/dev/null)" = YES ] || return 1
  echo "$version at $cfg"
}

llvm_sources() {
  require git "Install it with your package manager."
  [ -d "$LLVM_SRC/.git" ] && return
  say "cloning llvm-project at $LLVM_PIN"
  git clone --depth 1 --branch "$LLVM_PIN" \
    https://github.com/llvm/llvm-project.git "$LLVM_SRC"
}

llvm_configure() {
  require cmake "Install it with your package manager."
  require ninja "Install it with your package manager (package 'ninja-build')."
  cmake -S "$LLVM_SRC/llvm" -B "$LLVM_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_ENABLE_ASSERTIONS=ON \
    -DLLVM_ENABLE_RTTI=ON -DLLVM_ENABLE_EH=ON \
    -DLLVM_TARGETS_TO_BUILD=X86 \
    -DLLVM_BUILD_TOOLS=ON -DLLVM_BUILD_UTILS=OFF \
    -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INSTALL_UTILS=OFF \
    -DCMAKE_INSTALL_PREFIX="$PREFIX"
}

install_llvm() {
  llvm_sources
  llvm_configure
  say "building llvm with $JOBS jobs; this is the slow one, roughly an hour"
  ninja -C "$LLVM_BUILD" -j"$JOBS"
  ninja -C "$LLVM_BUILD" install
}

# --- alive2 ------------------------------------------------------------------
have_alive2() {
  local bin major
  bin=$(find_tool alive-tv) || return 1
  major=$(tool_llvm_major "$bin")
  if [ -n "$major" ] && [ "$major" != "$LLVM_MAJOR" ]; then return 1; fi
  echo "$bin${major:+ (LLVM $major)}"
}

install_alive2() {
  require git "Install it with your package manager."
  require cmake "Install it with your package manager."
  require ninja "Install it with your package manager (package 'ninja-build')."
  [ -f /usr/include/z3.h ] ||
    die "Z3 development headers not found. Install them, for example with
       sudo apt install libz3-dev
alive2 needs Z3; building Z3 is out of scope here."
  ensure llvm 0
  local cfg
  cfg=$(find_llvm_config) || die "alive2: no llvm-config"

  if [ ! -d "$ALIVE2_SRC/.git" ]; then
    say "cloning alive2"
    git clone https://github.com/AliveToolkit/alive2.git "$ALIVE2_SRC"
  fi
  say "checking out alive2 at $ALIVE2_PIN"
  git -C "$ALIVE2_SRC" fetch --quiet origin
  git -C "$ALIVE2_SRC" checkout --quiet "$ALIVE2_PIN"

  # BUILD_LLVM_UTILS is what makes alive2 build alive-tv at all. The heavier
  # BUILD_TV additionally builds the opt plugin, which we do not use.
  say "building alive-tv against LLVM $("$cfg" --version)"
  cmake -S "$ALIVE2_SRC" -B "$ALIVE2_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_LLVM_UTILS=1 \
    -DLLVM_DIR="$("$cfg" --cmakedir)"
  ninja -C "$ALIVE2_BUILD" -j"$JOBS" alive-tv
  local built
  built=$(find "$ALIVE2_BUILD" -maxdepth 2 -type f -name alive-tv | head -1)
  [ -n "$built" ] || die "alive2 built but alive-tv is not under $ALIVE2_BUILD"
  mkdir -p "$PREFIX/bin"
  cp "$built" "$PREFIX/bin/alive-tv"
}

# --- llubi -------------------------------------------------------------------
# Upstream builds the interpreter as `llubi_legacy`, and that name is kept: a
# binary called `llubi` on PATH is most likely the in-tree rewrite, which is a
# different tool. The check confirms which one it found by a flag only the
# out-of-tree interpreter has.
have_llubi() {
  local bin major
  bin=$(find_tool llubi_legacy) || return 1
  "$bin" --help 2>&1 | grep -q -- --verify-value-tracking || return 1
  major=$(tool_llvm_major "$bin")
  if [ -n "$major" ] && [ "$major" != "$LLVM_MAJOR" ]; then return 1; fi
  echo "$bin${major:+ (LLVM $major)}"
}

install_llubi() {
  require git "Install it with your package manager."
  require cmake "Install it with your package manager."
  require ninja "Install it with your package manager (package 'ninja-build')."
  ensure llvm 0
  local cfg
  cfg=$(find_llvm_config) || die "llubi: no llvm-config"

  if [ ! -d "$LLUBI_SRC/.git" ]; then
    say "cloning llubi"
    git clone "$LLUBI_REPO" "$LLUBI_SRC"
  fi
  say "checking out llubi at $LLUBI_PIN"
  git -C "$LLUBI_SRC" fetch --quiet origin
  git -C "$LLUBI_SRC" checkout --quiet "$LLUBI_PIN"

  say "building llubi against LLVM $("$cfg" --version)"
  cmake -S "$LLUBI_SRC" -B "$LLUBI_BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_DIR="$("$cfg" --cmakedir)"
  ninja -C "$LLUBI_BUILD" -j"$JOBS" llubi_legacy
  local built
  built=$(find "$LLUBI_BUILD" -maxdepth 2 -type f -name llubi_legacy | head -1)
  [ -n "$built" ] || die "llubi built but llubi_legacy is not under $LLUBI_BUILD"
  mkdir -p "$PREFIX/bin"
  cp "$built" "$PREFIX/bin/llubi_legacy"
}

# --- bun and the JS packages -------------------------------------------------
have_bun() {
  local bin
  bin=$(find_tool bun) || return 1
  echo "$bin ($("$bin" --version 2>/dev/null))"
}

install_bun() {
  require curl "Install it with your package manager."
  say "installing bun into $PREFIX"
  BUN_INSTALL="$PREFIX" bash -c "$(curl -fsSL https://bun.sh/install)"
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
  say "installing uv into $PREFIX/bin"
  # A flat layout puts the binary straight into the directory named here, and
  # no modification of shell profiles: PATH is the Makefile's business.
  UV_INSTALL_DIR="$PREFIX/bin" UV_NO_MODIFY_PATH=1 \
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
  printf 'prefix: %s\n\n' "$PREFIX"
  for name in "${DEP_NAMES[@]}"; do
    if desc=$("have_$name"); then
      printf '  \033[1;32m%-8s\033[0m %s\n' "$name" "$desc"
    else
      printf '  \033[1;31m%-8s\033[0m missing\n' "$name"
      missing=1
    fi
  done
  printf '\npins: llvm %s, alive2 %s, llubi %s\n' "$LLVM_PIN" "$ALIVE2_PIN" "$LLUBI_PIN"
  [ "$missing" = 0 ] || printf "run 'make install-deps' to install what is missing\n"
}

# Where CMake finds the LLVM llops builds against. Any LLVM recent enough
# works for llops on its own, so this does not insist on the pin; sharing one
# LLVM with alive2 is what install does.
llvm_cmakedir() {
  local cfg
  cfg=$(find_llvm_config) ||
    die "no llvm-config found. Run 'make install-deps', or install LLVM $LLVM_MAJOR."
  "$cfg" --cmakedir
}

case "${1:-status}" in
  install)
    for name in "${DEP_NAMES[@]}"; do ensure "$name" "${FORCE:-0}"; done
    say "done. Put $PREFIX/bin on PATH to use these tools outside make."
    ;;
  status) status ;;
  llvm-cmakedir) llvm_cmakedir ;;
  llvm | alive2 | llubi | bun | js | uv | py | dev) ensure "$1" "${FORCE:-0}" ;;
  *)
    die "usage: $(basename "$0") <install|status|llvm-cmakedir|${DEP_NAMES[*]}>"
    ;;
esac
