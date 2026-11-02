#!/usr/bin/env bash
set -euo pipefail

WEB_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  if [[ "$arg" == -h || "$arg" == --help ]]; then
    echo "Usage: $0 [--jobs N]"
    echo "Check dependencies, build the Wasm tools, run the probe, and bundle the static site."
    echo "Uses the native toolchain selected by scripts/depman.sh."
    exit 0
  fi
done

for tool in make python3 node bun git cmake ninja re2c timeout; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing build tool: $tool" >&2
    exit 1
  fi
done
if [[ ! -x /usr/bin/time ]]; then
  echo "Missing GNU time at /usr/bin/time" >&2
  exit 1
fi

"$WEB_ROOT/scripts/build-tools.sh" alive2 "$@"
node "$WEB_ROOT/scripts/probe.mjs" llops alive2
(cd "$WEB_ROOT" && bun install --frozen-lockfile && bun run check)
exec bun "$WEB_ROOT/scripts/bundle-site.ts"
