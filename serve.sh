#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8080}"
DIR="${2:-dist}"

if [ ! -d "$DIR" ]; then
  echo "Directory '$DIR' not found. Run './rebuild.sh' first." >&2
  exit 1
fi

echo "Serving $DIR on http://localhost:$PORT"

# Try Python 3 first, then fall back to npx serve
if command -v python3 &>/dev/null; then
  python3 -m http.server "$PORT" --directory "$DIR"
elif command -v python &>/dev/null; then
  python -m http.server "$PORT" --directory "$DIR"
elif command -v npx &>/dev/null; then
  npx serve "$DIR" -l "$PORT"
else
  echo "No web server found. Install Python or run: npm run preview" >&2
  exit 1
fi
