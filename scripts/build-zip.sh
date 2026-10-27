#!/usr/bin/env bash
# Construye el ZIP instalable: bash scripts/build-zip.sh [SALIDA.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
command -v zip >/dev/null || { echo "Falta 'zip' (Termux: pkg install zip)"; exit 1; }
VERSION=$(node -p "require('./package.json').version")
OUT="${1:-../colab-manager-v${VERSION}.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
[ -e "$OUT" ] && { echo "Ya existe $OUT (no se sobrescribe)"; exit 1; }
node scripts/make-example-notebook.js >/dev/null
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/colab-manager"
tar -c --exclude='./node_modules' --exclude='./.git' --exclude='__pycache__' --exclude='*.zip' \
    --exclude='*.tmp' --exclude='*.bak' --exclude='./config.json' --exclude='./data' . | tar -x -C "$STAGE/colab-manager"
(cd "$STAGE" && zip -qr "$OUT" colab-manager)
echo "ZIP creado: $OUT"
