#!/bin/bash
# preupgrade.sh laeuft bei einem UPDATE (nicht bei der Erstinstallation) als
# User "loxberry", BEVOR LoxBerrys eigener Installer die vorherige Version
# entfernt ("purge_installation" in sbin/plugininstall.pl) - das loescht bei
# JEDEM Update komplett "config/plugins/miraibridge/", inklusive bridge.json,
# nicht nur bei einer Deinstallation. Gleicher Bug/gleicher Fix wie bei
# LoxBerry-Plugin-EaseeMQTT (siehe dessen preupgrade.sh) - hier auf Hardware
# bestaetigt: nach einem Plugin-Update war bridge.json komplett leer
# ("panels": []), alle Panel-/Raum-/Audio-Zuordnungen weg.
#
# Sichert bridge.json an einen Ort ausserhalb von config/plugins/... -
# postroot.sh (das NACH der Neuanlage des Ordners laeuft) stellt sie wieder
# her. Siehe dort fuer die Gegenseite dieses Mechanismus.
#
# Echte Parameterreihenfolge (siehe plugininstall.pl, identisch zu
# postroot.sh): $1=tempfile $2=pname $3=pfolder $4=pversion $5=lbhomedir
# $6=tempfolder. $3 statt hart "miraibridge" verdrahtet, falls LoxBerry bei
# einer Name/Folder-Kollision einen anderen Ordnernamen vergibt (siehe
# EaseeMQTT-Kommentar in dessen postroot.sh fuer den Hintergrund).
LBHOMEDIR="${5:-/opt/loxberry}"
PFOLDER="${3:-miraibridge}"
CFGDIR="$LBHOMEDIR/config/plugins/$PFOLDER"
BACKUP_DIR="/tmp/miraibridge-preupgrade-backup"

mkdir -p "$BACKUP_DIR"
[ -f "$CFGDIR/bridge.json" ] && cp -a "$CFGDIR/bridge.json" "$BACKUP_DIR/bridge.json"

exit 0
