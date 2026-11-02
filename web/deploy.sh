#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0"
  echo "Commit web/dist/ to the local web branch without changing the checkout or pushing."
}

if (($#)); then
  if [[ $# == 1 && ("$1" == -h || "$1" == --help) ]]; then
    usage
    exit 0
  fi
  usage >&2
  exit 1
fi

fail() {
  echo "Deploy failed: $*" >&2
  exit 1
}

web_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dist="$web_root/dist"
branch=refs/heads/web
repo_git_dir="$(git -C "$web_root" rev-parse --absolute-git-dir)"

for file in index.html .nojekyll revision.txt; do
  [[ -f "$dist/$file" ]] || fail "Missing web/dist/$file; run ./web/build.sh first."
done
revision="$(<"$dist/revision.txt")"
[[ "$revision" =~ ^[0-9a-f]+(-dirty)?$ ]] || fail "Invalid build revision in web/dist/revision.txt."

# Updating a checked-out branch would leave its files and index behind its new HEAD.
worktrees="$(git -C "$web_root" worktree list --porcelain)"
while IFS= read -r entry; do
  [[ "$entry" != "branch $branch" ]] || fail "The web branch is checked out; switch it away first."
done <<<"$worktrees"

previous="$(git -C "$web_root" rev-parse --verify --quiet "$branch" || true)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

# An empty, private index makes dist the entire branch root, including dotfiles.
# No checkout, source index or tracked working file participates in this commit.
dist_git() {
  GIT_INDEX_FILE="$scratch/index" git --git-dir="$repo_git_dir" --work-tree="$dist" -C "$dist" "$@"
}

dist_git read-tree --empty
dist_git add --all --force -- .
tree="$(dist_git write-tree)"
parents=()
if [[ -n "$previous" ]]; then
  if [[ "$tree" == "$(git -C "$web_root" rev-parse "$previous^{tree}")" ]]; then
    echo "The web branch already matches web/dist/."
    exit 0
  fi
  parents=(-p "$previous")
fi

commit="$(git -C "$web_root" commit-tree "$tree" "${parents[@]}" \
  -m "chore: update the web site with $revision" \
  -m "Publish the contents of web/dist/ at the branch root.")"

# Compare the old tip so a concurrent deployment cannot overwrite another commit.
git -C "$web_root" update-ref -m "deploy web/dist/" "$branch" "$commit" "$previous"
echo
echo
echo "====================================================="
echo "Updated local web branch to $commit ($revision)."
echo "To publish: git push origin web"
