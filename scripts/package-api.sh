#!/usr/bin/env bash
#
# Builds the deployment package for `apps/api` (EXPD-008).
#
# App Service runs the API with `node apps/api/dist/index.js`, from a zip
# mounted read-only: `WEBSITE_RUN_FROM_PACKAGE` is 1 and
# `SCM_DO_BUILD_DURING_DEPLOYMENT` is false (EXPD-007). So the zip has to
# arrive complete — built JavaScript and every runtime dependency — because
# nothing installs or compiles anything on the far side.
#
# Two things this is careful about.
#
# 1. **No symlinks.** npm links a workspace into `node_modules` rather than
#    copying it, and a symlink is not something to bet a deployment on: the
#    zip is mounted as a filesystem, not unpacked by npm. The three
#    `@explorer/*` links are replaced with real directories holding the built
#    `dist/`, and the script fails if any symlink is left.
# 2. **Runtime dependencies only, from the lock file.** The install is
#    `npm ci --omit=dev` scoped to the API workspace, so the versions are the
#    ones `package-lock.json` pins and the tree is express and what express
#    needs — not the 305 MB the dev install is, and not `react-native`, which
#    is a runtime dependency of a workspace that has nothing to do with this.
#
# Usage:
#   scripts/package-api.sh            # build, stage, verify, zip
#   scripts/package-api.sh --no-zip   # stop after verifying the staged tree

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$root/dist-deploy/api"
zip_path="$root/dist-deploy/api.zip"

make_zip=1
[[ "${1:-}" == "--no-zip" ]] && make_zip=0

say() { printf '\n[package-api] %s\n' "$1"; }

# The workspaces the API needs at runtime. `apps/api` is the code; the two
# packages are what it imports.
runtime_packages=(shared-types engine)

say 'Building packages and the API'
npm --prefix "$root" run build:packages
npm --prefix "$root" run build -w @explorer/api

say "Staging into ${stage#"$root"/}"
rm -rf "$root/dist-deploy"
mkdir -p "$stage"

# `npm ci` needs the manifests the lock file was written against, so every
# workspace's package.json is staged before the install and the ones the API
# does not need are removed after it.
cp "$root/package.json" "$root/package-lock.json" "$stage/"
while IFS= read -r manifest; do
  rel="${manifest#"$root"/}"
  mkdir -p "$stage/$(dirname "$rel")"
  cp "$manifest" "$stage/$rel"
done < <(find "$root/apps" "$root/packages" -maxdepth 2 -name package.json -not -path '*/node_modules/*')

say 'Installing runtime dependencies'
npm --prefix "$stage" ci \
  --omit=dev \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --workspace @explorer/api \
  --include-workspace-root

say 'Replacing workspace links with the built output'
rm -rf "$stage/node_modules/@explorer"
mkdir -p "$stage/node_modules/@explorer"
for pkg in "${runtime_packages[@]}"; do
  src="$root/packages/$pkg"
  [[ -d "$src/dist" ]] || { echo "packages/$pkg has no dist/ — the build did not run" >&2; exit 1; }
  dest="$stage/node_modules/@explorer/$pkg"
  mkdir -p "$dest"
  cp "$src/package.json" "$dest/package.json"
  cp -R "$src/dist" "$dest/dist"
done

say 'Copying the built API'
cp -R "$root/apps/api/dist" "$stage/apps/api/dist"

# The staged manifests were only there for `npm ci`. What ships is the API's
# own package.json — App Service reads `type` and `main` from it — and a root
# manifest that names the entry point instead of a workspace layout that no
# longer exists inside the zip.
find "$stage/apps" "$stage/packages" -mindepth 1 -maxdepth 1 -type d \
  -not -path "$stage/apps/api" -exec rm -rf {} +
rm -rf "$stage/packages" "$stage/package-lock.json"

node - "$root/package.json" "$stage/package.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [, , from, to] = process.argv;
const { version } = JSON.parse(readFileSync(from, 'utf8'));

writeFileSync(
  to,
  `${JSON.stringify(
    {
      name: 'explorer-expedition-api',
      version,
      private: true,
      type: 'module',
      main: 'apps/api/dist/index.js',
    },
    null,
    2,
  )}\n`,
);
NODE

# Build state, not runtime code.
find "$stage" -name '*.tsbuildinfo' -delete

say 'Checking the package'
leftover_links="$(find "$stage" -type l)"
if [[ -n "$leftover_links" ]]; then
  echo 'These are symlinks, and a mounted zip will not resolve them:' >&2
  echo "$leftover_links" >&2
  exit 1
fi

[[ -f "$stage/apps/api/dist/index.js" ]] || { echo 'apps/api/dist/index.js is missing' >&2; exit 1; }
[[ -d "$stage/node_modules/express" ]] || { echo 'express is missing' >&2; exit 1; }

# The real check: start the thing and ask it how it is. This is the same
# command App Service runs, against the same tree, so a package that cannot
# serve /health fails here rather than after it is deployed.
port=8123
(cd "$stage" && PORT="$port" node apps/api/dist/index.js >/dev/null 2>&1) &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT

health=''
for _ in $(seq 1 40); do
  health="$(curl -fsS --noproxy 127.0.0.1 "http://127.0.0.1:$port/health" 2>/dev/null || true)"
  [[ -n "$health" ]] && break
  sleep 0.25
done

kill "$api_pid" 2>/dev/null || true
trap - EXIT

if [[ "$health" != *'"status":"ok"'* ]]; then
  echo "The staged package did not serve /health. Got: ${health:-<nothing>}" >&2
  exit 1
fi
say "/health answered ${health}"

if (( make_zip )); then
  command -v zip >/dev/null || { echo 'zip is not installed' >&2; exit 1; }
  say "Writing ${zip_path#"$root"/}"
  (cd "$stage" && zip -qr "$zip_path" .)
  say "Done: $(du -h "$zip_path" | cut -f1)"
else
  say 'Done (--no-zip)'
fi
