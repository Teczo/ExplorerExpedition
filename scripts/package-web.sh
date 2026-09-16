#!/usr/bin/env bash
#
# Builds the deployment package for one of the three React apps (EXPD-008).
#
# The stack puts `creator-web`, `studio` and `admin` on Vercel. Vercel can
# build a project itself, but then the build that ships is not the build CI
# checked — a different machine, a different install, a different moment. So
# CI builds them with the toolchain it already verified, and hands Vercel the
# finished output.
#
# The shape it hands over is the Build Output API (version 3): a
# `.vercel/output` directory holding the static files and one config file
# saying how to route them. `vercel deploy --prebuilt` uploads exactly that
# and runs no build of its own.
#
# The routing is the one thing the config has to get right. These are
# single-page apps: the server holds one `index.html` and React decides what
# to draw from the URL. `handle: filesystem` serves a real file when there is
# one — every hashed asset under `/assets/` — and anything left over falls
# through to `index.html`, so a reload on a deep link renders the app instead
# of a 404.
#
# Usage:
#   scripts/package-web.sh creator-web

set -euo pipefail

app="${1:-}"
case "$app" in
  creator-web | studio | admin) ;;
  *)
    echo "Usage: scripts/package-web.sh <creator-web|studio|admin>" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stage="$root/dist-deploy/web/$app"

say() { printf '\n[package-web:%s] %s\n' "$app" "$1"; }

say 'Building'
# The apps import `@explorer/shared-types` from its built output, so the
# packages have to be built before any of them can be.
npm --prefix "$root" run build:packages
npm --prefix "$root" run build -w "@explorer/$app"

built="$root/apps/$app/dist"
[[ -f "$built/index.html" ]] || { echo "apps/$app/dist/index.html is missing — the build did not run" >&2; exit 1; }

say "Staging into ${stage#"$root"/}"
rm -rf "$stage"
mkdir -p "$stage/.vercel/output"
cp -R "$built" "$stage/.vercel/output/static"

cat > "$stage/.vercel/output/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    { "handle": "filesystem" },
    { "src": "/.*", "dest": "/index.html" }
  ]
}
JSON

say 'Checking the package'
[[ -f "$stage/.vercel/output/static/index.html" ]] || { echo 'index.html did not reach the package' >&2; exit 1; }
node --input-type=module -e "
  import { readFileSync } from 'node:fs';
  const config = JSON.parse(readFileSync('$stage/.vercel/output/config.json', 'utf8'));
  if (config.version !== 3) throw new Error('the Build Output API version has to be 3');
"

say "Done: $(du -sh "$stage" | cut -f1)"
