#!/bin/bash
# Postroot (laeuft als User "root"): systemd-Service fuer die MiraiBridge
# einrichten. Fallback-Pfade fuer LoxBerry-Versionen, die $PBIN/$PLOG nicht setzen.

# $3 (pfolder) statt hart "miraibridge" verdrahtet, falls LoxBerry bei einer
# Name/Folder-Kollision (siehe PluginDB.pm) einen anderen Ordnernamen
# vergibt — echte Parameterreihenfolge siehe preupgrade.sh.
PLUGIN_FOLDER="${3:-miraibridge}"
LBHOME="${LBHOMEDIR:-/opt/loxberry}"
RESOLVED_PBIN="${PBIN:-${LBHOME}/bin/plugins/${PLUGIN_FOLDER}}"
RESOLVED_PLOG="${PLOG:-${LBHOME}/log/plugins/${PLUGIN_FOLDER}}"
RESOLVED_PCFG="${PCONFIG:-${LBHOME}/config/plugins/${PLUGIN_FOLDER}}"

echo "PBIN (verwendet): $RESOLVED_PBIN"
echo "PLOG (verwendet): $RESOLVED_PLOG"
echo "PCONFIG (verwendet): $RESOLVED_PCFG"

# Von preupgrade.sh gesicherte bridge.json wiederherstellen (siehe dort):
# LoxBerrys eigener Installer loescht "$RESOLVED_PCFG" bei JEDEM Update
# komplett, BEVOR postroot.sh ueberhaupt laeuft — auf Hardware bestaetigt
# (2026-09-10: nach einem Update war bridge.json leer, alle Panel-/Raum-/
# Audio-Zuordnungen weg). Bei einer echten Erstinstallation existiert kein
# Backup (preupgrade.sh laeuft dann gar nicht erst) — dann greift die
# mitgelieferte Default-Config unten.
mkdir -p "$RESOLVED_PCFG"
BACKUP_DIR="/tmp/miraibridge-preupgrade-backup"
if [ -f "$BACKUP_DIR/bridge.json" ]; then
  cp -a "$BACKUP_DIR/bridge.json" "$RESOLVED_PCFG/bridge.json"
  echo "bridge.json aus Preupgrade-Backup wiederhergestellt"
fi
rm -rf "$BACKUP_DIR"

# Default-Config anlegen, falls noch keine existiert (echte Erstinstallation;
# wird spaeter ueber Web-UI ueberschrieben)
if [ ! -f "$RESOLVED_PCFG/bridge.json" ]; then
  cp "$(dirname "$0")/config/bridge.json" "$RESOLVED_PCFG/bridge.json"
  echo "Default-bridge.json angelegt"
fi
# postroot.sh laeuft als root — api.php (User "loxberry") muss bridge.json
# spaeter beim Speichern ueberschreiben koennen (gleiches Muster/gleicher
# Bug wie bei EaseeMQTT/KNXtoLOX).
chown -R loxberry.loxberry "$RESOLVED_PCFG" 2>/dev/null || true

# PHP-GD installieren (wird vom Cover-Proxy für PNG→JPEG-Konvertierung benötigt)
echo "Prüfe php-gd..."
if php -r 'exit(extension_loaded("gd") ? 0 : 1);' 2>/dev/null; then
    echo "php-gd bereits vorhanden."
else
    echo "Installiere php-gd..."
    apt-get install -y php-gd 2>&1 || echo "WARNUNG: php-gd konnte nicht installiert werden — PNG-Covers werden nicht konvertiert"
fi

SERVICE_NAME="miraibridge"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ ! -d "$RESOLVED_PBIN" ]; then
    echo "Plugin-Verzeichnis nicht gefunden: $RESOLVED_PBIN"
    exit 1
fi

# Log-Verzeichnis anlegen falls nicht vorhanden
mkdir -p "$RESOLVED_PLOG"
chown loxberry.loxberry "$RESOLVED_PLOG" 2>/dev/null || true

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
    echo "Node.js nicht gefunden — Service wird nicht gestartet"
    exit 1
fi

echo "Node.js: $NODE_BIN ($(node --version))"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=MiraiBridge (Loxone <-> MQTT)
After=network-online.target mosquitto.service
Wants=network-online.target

[Service]
Type=simple
Environment=LBHOMEDIR=${LBHOME}
ExecStart=${NODE_BIN} ${RESOLVED_PBIN}/bridge.js
WorkingDirectory=${RESOLVED_PBIN}
Restart=on-failure
RestartSec=5
User=loxberry
StandardOutput=append:${RESOLVED_PLOG}/bridge.log
StandardError=append:${RESOLVED_PLOG}/bridge.log

[Install]
WantedBy=multi-user.target
EOF

echo "Service-Datei geschrieben: $SERVICE_FILE"
chmod 644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
echo "Service Status:"
systemctl status "$SERVICE_NAME" --no-pager || true

exit 0
