#!/usr/bin/env bash
# Cross-compile pinned tools in an isolated tree; the native toolchain is read-only.
set -euo pipefail

WEB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd -- "$WEB_ROOT/.." && pwd)"
BUILD_ROOT="$WEB_ROOT/build"

EMSDK_VERSION=4.0.23
Z3_TAG="z3-4.8.12"
Z3_PIN=3a402ca2c14c3891d24658318406f80ce59b719f

stage=""
jobs=2

usage() {
  echo "Usage: $0 {llops|alive2|llubi|all|z3timer} [--jobs N]"
}

die() {
  echo "$*" >&2
  exit 1
}

run() {
  printf '+ '
  printf '%q ' "$@"
  printf '\n'
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --jobs)
      [[ $# -ge 2 ]] || die "--jobs requires a positive integer"
      jobs=$2
      shift 2
      ;;
    --jobs=*)
      jobs=${1#*=}
      shift
      ;;
    -*) die "Unknown option: $1" ;;
    *)
      [[ -z "$stage" ]] || die "Unexpected argument: $1"
      stage=$1
      shift
      ;;
  esac
done

case "$stage" in llops | alive2 | llubi | all | z3timer) ;; *)
  usage >&2
  exit 1
  ;;
esac

[[ "$jobs" =~ ^[0-9]+$ && "$jobs" =~ [1-9] ]] || die "--jobs must be a positive integer"

# Missing project dependencies must stop the build before any downloads or setup.
if ! run make --no-print-directory -C "$PROJECT_ROOT" deps-status; then
  die "Dependency check failed; see make deps-status output above"
fi

native_dir="$("$PROJECT_ROOT/scripts/depman.sh" toolchain)"

# Read the native pins from their owner so both builds use the same revisions.
pin() { sed -n "s/^${1}_PIN=//p" "$PROJECT_ROOT/scripts/depman.sh"; }

require_revision() {
  local source=$1 revision=$2 actual expected

  actual=$(git -C "$source" rev-parse HEAD)
  expected=$(git -C "$source" rev-parse "$revision^{commit}")
  [[ "$actual" == "$expected" ]] || die "$source: expected $expected, found $actual"
}

# Reuse cached checkouts only at the requested revision; never reset local work.
checkout() {
  local source=$1 repo=$2 ref=$3 revision=${4:-$3}

  if [[ ! -e "$source" ]]; then
    mkdir -p -- "$(dirname -- "$source")"
    run git clone --depth 1 --branch "$ref" "$repo" "$source"
  fi

  require_revision "$source" "$revision"
}

apply_port_patch() {
  local source=$1 patch=$2

  # A repeated build can encounter a port patch that is already applied.
  if git -C "$source" apply --unidiff-zero --reverse --check "$patch" >/dev/null 2>&1; then return; fi

  run git -C "$source" apply --unidiff-zero --check "$patch"
  run git -C "$source" apply --unidiff-zero "$patch"
}

# Port patches belong in isolated copies, leaving the native sources untouched.
ported() {
  local name=$1 source=$2 revision=$3 destination

  destination="$BUILD_ROOT/$name-src"
  if [[ ! -e "$destination" ]]; then run git clone --shared "$source" "$destination"; fi

  require_revision "$destination" "$revision"
  apply_port_patch "$destination" "$WEB_ROOT/patches/$name.patch"
}

# The timer-only test needs no LLVM build; other stages reuse native TableGen.
if [[ "$stage" != z3timer ]]; then
  for entry in LLVM:llvm-project ALIVE2:alive2 LLUBI:llubi-legacy; do
    source="$native_dir/${entry#*:}"
    [[ -e "$source/.git" ]] || die "Missing native source at $source; run make install-deps"
    require_revision "$source" "$(pin "${entry%%:*}")"
  done

  [[ -x "$native_dir/llvm-project/build/bin/llvm-tblgen" ]] || die "Missing native llvm-tblgen; run make install-deps"
fi

# Keep the compiler and its cache inside the web build tree.
sdk="$BUILD_ROOT/emsdk"
checkout "$sdk" https://github.com/emscripten-core/emsdk.git "$EMSDK_VERSION"
run "$sdk/emsdk" install "$EMSDK_VERSION"
run "$sdk/emsdk" activate "$EMSDK_VERSION"

# A caller's active SDK must not redirect this build to another compiler/cache.
export EM_CONFIG="$sdk/.emscripten"
export EM_CACHE="$sdk/upstream/emscripten/cache"
emcmake="$sdk/upstream/emscripten/emcmake"

# Validate timeout delivery before building Z3: single-threaded Wasm uses polling.
case "$stage" in z3timer | alive2 | all)
  z3="$BUILD_ROOT/z3-src"
  checkout "$z3" https://github.com/Z3Prover/z3.git "$Z3_TAG" "$Z3_PIN"
  apply_port_patch "$z3" "$WEB_ROOT/patches/z3.patch"

  run "$sdk/upstream/emscripten/em++" -std=c++17 -Wall -Wextra -Werror -fexceptions \
    "-I$z3/src" "-I$WEB_ROOT/cmake" "$z3/src/util/scoped_timer.cpp" "$WEB_ROOT/test/z3timer.cpp" \
    -sINVOKE_RUN=0 "-sEXPORTED_RUNTIME_METHODS=['callMain','FS','HEAPU8']" \
    -sALLOW_MEMORY_GROWTH=1 -o "$BUILD_ROOT/z3timer.mjs"

  printf '%s' '{"args":[]}' | node "$WEB_ROOT/scripts/invoke.mjs" "$BUILD_ROOT/z3timer.mjs" | node -e '
    const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (result.exit !== 0 || result.stdout !== "z3 timers passed") {
      console.error("Z3 timer test failed:", result);
      process.exit(1);
    }
    console.log("Z3 timer: passed");
  '

  [[ "$stage" != z3timer ]] || exit 0
  ;;
esac

configure() {
  local source=$1 destination=$2
  shift 2

  run "$emcmake" cmake -S "$source" -B "$destination" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS=-fexceptions -DCMAKE_CXX_FLAGS=-fexceptions "$@"
}

build() {
  local directory=$1
  shift

  run cmake --build "$directory" --parallel "$jobs" --target "$@"
}

# The checkers need LLVM libraries, without target backends or LLVM executables.
llvm="$BUILD_ROOT/llvm"
configure "$native_dir/llvm-project/llvm" "$llvm" \
  -DBUILD_SHARED_LIBS=OFF -DLLVM_ENABLE_RTTI=ON -DLLVM_ENABLE_EH=ON \
  -DLLVM_ENABLE_ASSERTIONS=ON -DLLVM_ABI_BREAKING_CHECKS=WITH_ASSERTS \
  -DLLVM_TARGETS_TO_BUILD= -DLLVM_ENABLE_PROJECTS= \
  -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_TOOLS=OFF -DLLVM_BUILD_TOOLS=OFF -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_CURL=OFF \
  -DLLVM_ENABLE_BACKTRACES=OFF -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten \
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-emscripten \
  "-DLLVM_TABLEGEN=$native_dir/llvm-project/build/bin/llvm-tblgen" \
  "-DLLVM_NATIVE_TOOL_DIR=$native_dir/llvm-project/build/bin"

llvm_dir="-DLLVM_DIR=$llvm/lib/cmake/llvm"
configure "$WEB_ROOT/cmake" "$BUILD_ROOT/llops" "$llvm_dir" \
  -DWEB_TOOL=llops "-DWEB_TOOL_SOURCE=$PROJECT_ROOT/llops"

# Build only the transitive LLVM libraries needed by the external tools.
build "$llvm" LLVMPasses LLVMAsmParser LLVMIRReader
build "$BUILD_ROOT/llops" llops

[[ "$stage" != llops ]] || exit 0

case "$stage" in alive2 | all)
  ported alive2 "$native_dir/alive2" "$(pin ALIVE2)"

  # Native alive2 links shared Z3; static Wasm linking needs distinct SMT types.
  configure "$z3" "$BUILD_ROOT/z3" \
    -DZ3_BUILD_LIBZ3_SHARED=OFF -DZ3_SINGLE_THREADED=ON \
    -DZ3_BUILD_EXECUTABLE=OFF -DZ3_BUILD_TEST_EXECUTABLES=OFF \
    -DZ3_INCLUDE_GIT_DESCRIBE=OFF -DCMAKE_POLICY_DEFAULT_CMP0148=OLD \
    "-DCMAKE_INSTALL_PREFIX=$BUILD_ROOT/z3-install" \
    "-DCMAKE_CXX_FLAGS=-fexceptions -Dsmt=z3_smt -I$WEB_ROOT/cmake"
  build "$BUILD_ROOT/z3" libz3
  run cmake --install "$BUILD_ROOT/z3"

  configure "$WEB_ROOT/cmake" "$BUILD_ROOT/alive2" "$llvm_dir" \
    -DWEB_TOOL=alive2 "-DWEB_TOOL_SOURCE=$BUILD_ROOT/alive2-src" \
    -DCMAKE_DISABLE_FIND_PACKAGE_hiredis=ON -DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON \
    "-DZ3_INCLUDE_DIR=$BUILD_ROOT/z3-install/include" \
    "-DZ3_LIBRARIES=$BUILD_ROOT/z3-install/lib/libz3.a"
  build "$BUILD_ROOT/alive2" alive-tv
  ;;
esac

# llubi is optional and used by standalone probes rather than the browser UI.
case "$stage" in llubi | all)
  ported llubi "$native_dir/llubi-legacy" "$(pin LLUBI)"
  configure "$WEB_ROOT/cmake" "$BUILD_ROOT/llubi" "$llvm_dir" \
    -DWEB_TOOL=llubi "-DWEB_TOOL_SOURCE=$BUILD_ROOT/llubi-src"
  build "$BUILD_ROOT/llubi" llubi
  ;;
esac
