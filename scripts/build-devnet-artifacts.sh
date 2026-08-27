#!/usr/bin/env bash
# The Privacy SDK's local Devnet test harness (used by `pnpm --filter
# @strkret/agent-consumer demo:devnet`) hard-codes a path to a compiled Cairo
# contract artifact — three directories up from its own dist/testing folder
# — that the published npm package doesn't actually ship. See
# .../starknet-privacy-sdk/dist/testing/devnet.js:
#   join(__dirname, "../../../target/dev/privacy_Privacy.contract_class.json")
# This builds that artifact from source and drops it wherever the installed
# SDK actually resolves to — a plain node_modules/@starkware-libs/... under
# npm, or a content-addressable node_modules/.pnpm/@starkware-libs+.../...
# path under pnpm (what this repo uses). Re-run after any fresh install —
# a new pnpm store entry or an npm reinstall both wipe this.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TESTING_DIR="$(find . -path '*/@starkware-libs/starknet-privacy-sdk/dist/testing' -type d 2>/dev/null | head -1)"
if [ -z "$TESTING_DIR" ]; then
  echo "error: @starkware-libs/starknet-privacy-sdk not found under node_modules — run pnpm install first" >&2
  exit 1
fi
DEST="$TESTING_DIR/../../../target/dev"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "cloning starkware-libs/starknet-privacy..."
git clone --depth 1 https://github.com/starkware-libs/starknet-privacy "$WORKDIR/starknet-privacy"

echo "building packages/privacy with the repo's pinned Scarb version..."
(
  cd "$WORKDIR/starknet-privacy/packages/privacy"
  # requires asdf (or another version manager) picking up the cloned repo's
  # .tool-versions — currently scarb 2.18.0. Install it first if needed:
  #   asdf install scarb 2.18.0 && asdf set scarb 2.18.0   (from inside the clone)
  scarb build
)

mkdir -p "$DEST"
cp "$WORKDIR/starknet-privacy/target/dev/privacy_Privacy.contract_class.json" "$DEST/"
cp "$WORKDIR/starknet-privacy/target/dev/privacy_Privacy.compiled_contract_class.json" "$DEST/"
echo "done — artifacts in $(cd "$DEST" && pwd)"
