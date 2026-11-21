#!/usr/bin/env bash
# Build the alchemy packages this repro installs, before `pnpm install`.
#
# `Domain.Decision` is on alchemy main but not in a published release, and
# main's @alchemy.run/domain needs main's alchemy and @alchemy.run/cloudflare.
# This fetches alchemy at the pinned commit from GitHub, builds it, and packs
# the eight packages the repro overrides (see pnpm-workspace.yaml) into vendor/.
#
#   scripts/bootstrap-alchemy.sh            # clone into ~/.cache, build, pack
#   ALCHEMY_DIR=~/code/alchemy scripts/bootstrap-alchemy.sh
#                                           # build from an existing checkout at ALCHEMY_SHA
#   FORCE=1 scripts/bootstrap-alchemy.sh    # rebuild even if vendor/ is complete
#
# Needs git, Node 24+ and pnpm (alchemy pins pnpm 12.15 through packageManager).
set -euo pipefail

ALCHEMY_REPO="https://github.com/alchemy-run/alchemy.git"
ALCHEMY_SHA="de0bdeda2fcc9e506cb46bb6fe4a8d7a8591d0b8"
SHORT="${ALCHEMY_SHA:0:9}"
PACKAGES=(domain cloudflare sql docker cloudflare-runtime node-utils acme alchemy)

REPRO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$REPRO_DIR/vendor"

expected=(
  alchemy.run-domain alchemy.run-cloudflare alchemy.run-sql alchemy.run-docker
  alchemy.run-cloudflare-runtime alchemy.run-node-utils alchemy.run-acme alchemy
)
missing=0
for name in "${expected[@]}"; do
  [[ -f "$VENDOR/$name-main-$SHORT.tgz" ]] || missing=1
done
if [[ $missing -eq 0 && "${FORCE:-}" != "1" ]]; then
  echo "vendor/ already holds alchemy main @ $SHORT. Set FORCE=1 to rebuild."
  exit 0
fi

if [[ -n "${ALCHEMY_DIR:-}" ]]; then
  SRC="$ALCHEMY_DIR"
  head="$(git -C "$SRC" rev-parse HEAD)"
  if [[ "$head" != "$ALCHEMY_SHA" ]]; then
    echo "ALCHEMY_DIR is at $head, not $ALCHEMY_SHA." >&2
    echo "Check out $ALCHEMY_SHA there (with submodules/distilled), or unset ALCHEMY_DIR." >&2
    exit 1
  fi
else
  SRC="${XDG_CACHE_HOME:-$HOME/.cache}/alchemy-domain-repro/alchemy-$SHORT"
  if [[ ! -d "$SRC/.git" ]]; then
    echo "Fetching alchemy @ $SHORT into $SRC ..."
    mkdir -p "$SRC"
    git -C "$SRC" init -q
    git -C "$SRC" remote add origin "$ALCHEMY_REPO"
  fi
  git -C "$SRC" fetch -q --depth 1 origin "$ALCHEMY_SHA"
  git -C "$SRC" checkout -q --force FETCH_HEAD
  # Only distilled is part of alchemy's TypeScript workspace; floci and tcut aren't needed.
  git -C "$SRC" submodule update -q --init --depth 1 -- submodules/distilled
fi

echo "Installing and building alchemy (a few minutes the first time) ..."
(
  cd "$SRC"
  pnpm install --frozen-lockfile --ignore-scripts
  pnpm -r --filter "@alchemy.run/domain..." --filter "@alchemy.run/cloudflare..." \
    --filter "alchemy..." run build:package
)

# alchemy's build writes the build time into dist/.build-stamp (its own staleness
# check). Pin it to the commit time so every bootstrap packs byte-identical
# tarballs, matching the integrity hashes in pnpm-lock.yaml.
stamp="$(git -C "$SRC" log -1 --format=%cI "$ALCHEMY_SHA")"
for p in "${PACKAGES[@]}"; do
  f="$SRC/packages/$p/dist/.build-stamp"
  if [[ -f "$f" ]]; then printf '%s' "$stamp" > "$f"; fi
done

mkdir -p "$VENDOR"
find "$VENDOR" -name '*.tgz' -delete
for p in "${PACKAGES[@]}"; do
  (cd "$SRC/packages/$p" && pnpm pack --pack-destination "$VENDOR" >/dev/null)
done
for f in "$VENDOR"/*.tgz; do
  base="$(basename "$f")"
  mv "$f" "$VENDOR/${base%-2.0.0-*.tgz}-main-$SHORT.tgz"
done

echo "vendor/ now holds alchemy main @ $SHORT. Next: pnpm install"
