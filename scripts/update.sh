#!/usr/bin/env bash
# Actualiza el CÓDIGO desde un ZIP nuevo. Los datos (~/.colab-manager) no se tocan.
# Uso: bash scripts/update.sh /ruta/colab-manager-vX.Y.Z.zip
# Hace copia de datos y del código actual; si las pruebas del código nuevo fallan, vuelve al anterior.
main() {
  set -euo pipefail
  ZIP="${1:?Uso: bash scripts/update.sh ARCHIVO.zip}"
  [ -f "$ZIP" ] || { echo "No existe $ZIP"; exit 1; }
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  TS=$(date +%Y%m%d-%H%M%S)
  PREV="$HOME/colab-manager-codigo-anterior-$TS.tgz"
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

  echo "==> Copia de seguridad de datos"
  node "$DIR/colabctl.js" backup || echo "(sin datos que respaldar o falló la copia; se continúa con la copia del código)"
  echo "==> Copia del código actual: $PREV"
  tar -czf "$PREV" -C "$(dirname "$DIR")" "$(basename "$DIR")"

  unzip -q "$ZIP" -d "$TMP"
  NEW="$TMP/colab-manager"
  [ -f "$NEW/colabctl.js" ] && [ -f "$NEW/package.json" ] || { echo "El ZIP no contiene colab-manager/colabctl.js"; exit 1; }
  echo "==> Versión nueva: $(node -p "require('$NEW/package.json').version") (actual: $(node -p "require('$DIR/package.json').version"))"

  for d in cli config docs examples integrations jobs lib logs monitor notebooks providers recovery scripts storage templates tests; do
    rm -rf "$DIR/$d"
  done
  cp -R "$NEW"/. "$DIR"/
  chmod +x "$DIR/colabctl.js" "$DIR"/scripts/*.sh

  echo "==> Pruebas del código nuevo"
  if ( cd "$DIR" && node --test tests/*.test.js >/dev/null 2>&1 ); then
    echo "OK. Actualizado. El código anterior queda en $PREV"
  else
    echo "Las pruebas fallaron: se restaura el código anterior."
    tar -xzf "$PREV" -C "$(dirname "$DIR")"
    exit 1
  fi
}
main "$@"
exit $?
