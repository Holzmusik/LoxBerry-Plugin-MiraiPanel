#!/bin/bash
# Postinstall (laeuft als User "loxberry"): Node.js-Abhaengigkeiten installieren.
# Fallback-Pfade fuer LoxBerry-Versionen, die $PBIN nicht setzen.

PLUGIN_FOLDER="miraibridge"
LBHOME="${LBHOMEDIR:-/opt/loxberry}"
RESOLVED_PBIN="${PBIN:-${LBHOME}/bin/plugins/${PLUGIN_FOLDER}}"

echo "PBIN (verwendet): $RESOLVED_PBIN"

if [ ! -d "$RESOLVED_PBIN" ]; then
    echo "Plugin-Verzeichnis nicht gefunden: $RESOLVED_PBIN"
    exit 1
fi

cd "$RESOLVED_PBIN" || exit 1

if ! command -v node &>/dev/null; then
    echo "Node.js nicht gefunden — bitte Node.js >= 18 installieren"
    exit 1
fi

echo "Node.js: $(node --version)"
echo "Installiere Node.js Abhaengigkeiten in $RESOLVED_PBIN ..."
# --ignore-scripts verhindert, dass native Addons (utf-8-validate, bufferutil)
# per node-gyp kompiliert werden. g++ ist auf LoxBerry nicht installiert.
# Die betroffenen Module fallen auf Pure-JS zurueck und laufen einwandfrei.
npm install --omit=dev --ignore-scripts --no-fund --no-audit
echo "Node.js Abhaengigkeiten installiert"
exit 0
