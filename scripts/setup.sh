#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 20 或更高版本。" >&2
  exit 1
fi

npm install --omit=dev
exec node bin/ai-coding.js setup "$@"
