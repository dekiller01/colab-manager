#!/usr/bin/env bash
# Instalador de Colab Manager para Termux (se puede repetir sin riesgo).
# Uso:  bash scripts/install-termux.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
say() { printf '\n==> %s\n' "$*"; }
ask() { [ -t 0 ] && { read -r -p "$1 [s/N] " a; [[ "$a" =~ ^([sSyY]|si|SI|yes)$ ]]; } || return 1; }

if command -v pkg >/dev/null 2>&1 && [ -n "${PREFIX:-}" ]; then
  BIN="$PREFIX/bin"
  say "Instalando paquetes base (nodejs-lts, git, tar, zip, unzip)"
  pkg update -y
  pkg install -y nodejs-lts git tar zip unzip
  if [ "${INSTALL_RCLONE:-}" = 1 ] || ask "¿Instalar rclone (sincronizar con Google Drive)?"; then pkg install -y rclone; fi
  if [ "${INSTALL_PYTHON:-}" = 1 ] || ask "¿Instalar python (solo para ejecutar las pruebas de notebooks en el teléfono)?"; then pkg install -y python; fi
else
  echo "Aviso: no parece Termux; se usa ~/.local/bin y se asume que Node.js >= 18 ya está instalado."
  BIN="$HOME/.local/bin"; mkdir -p "$BIN"
fi

command -v node >/dev/null || { echo "ERROR: Node.js no está instalado."; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || { echo "ERROR: se requiere Node.js >= 18 (hay $(node -v))."; exit 1; }

say "Creando el comando 'colabctl' en $BIN"
SH="${PREFIX:-/usr}/bin/sh"; [ -x "$SH" ] || SH=/bin/sh
printf '#!%s\nexec node "%s/colabctl.js" "$@"\n' "$SH" "$DIR" > "$BIN/colabctl"
chmod 700 "$BIN/colabctl"
chmod +x "$DIR/colabctl.js" "$DIR"/scripts/*.sh

say "Inicializando datos (~/.colab-manager) — no se sobrescribe nada existente"
node "$DIR/colabctl.js" init

say "Ejecutando pruebas automáticas locales"
( cd "$DIR" && node --test tests/*.test.js ) && echo "Pruebas locales: OK" || { echo "Alguna prueba falló: revise la salida de arriba."; exit 1; }

say "Diagnóstico"
node "$DIR/colabctl.js" doctor || true
cat <<MSG

Listo. Pruebe:  colabctl status
Guía completa: $DIR/README.md
(Si 'colabctl' no se encuentra, cierre y abra Termux, o use: node $DIR/colabctl.js status)
MSG
