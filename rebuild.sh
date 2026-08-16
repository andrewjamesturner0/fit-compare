#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Rebuilding production files in dist..."
npm run build -- --emptyOutDir
echo "Production rebuild complete."
