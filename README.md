# MiraiBridge

LoxBerry-Plugin, das die [MiraiPanel-LCD](https://github.com/Holzmusik/MiraiPanel-LCD)-Firmware
(ESP32-P4-Touchpanel für Loxone) mit einem Loxone-Miniserver verbindet.

Übersetzt zwischen Loxone (Miniserver-WebSocket, `jdev/sps/io/...`) und MQTT
in dem Topic-Schema, das die Firmware erwartet — Heizung, Jalousien, Licht,
Schalter, Sensoren, Szenen und (neu) Audio-Zonen (echter Loxone Audioserver
oder Sonn Core, siehe unten).

## Komponenten

- `bin/bridge.js` — Node-Dienst: Miniserver-WebSocket ↔ MQTT-Broker,
  läuft dauerhaft als systemd-Dienst.
- `bin/audioserver.js` — direkte WebSocket-Verbindung zu einem Loxone
  Audioserver (oder Sonn Core, das denselben nachbildet) für Titel/Artist/
  Cover/Lautstärke-Updates in Echtzeit, unabhängig von der Loxone-Struktur.
- `webfrontend/htmlauth/` — Konfigurationsoberfläche (Panel-Zuordnung,
  Raum-/Control-Auswahl aus `LoxAPP3.json`, Sensor-Ziele, Audio-Setup).
- `webfrontend/html/cover_proxy.php` — Cover-Art-Proxy (Resize via GD),
  ohne Login erreichbar (Zugriff vom Panel selbst).

## Installation

1. Plugin als ZIP über "Plugin installieren" hochladen.
2. `postinstall.sh` installiert die Node.js-Abhängigkeiten (`bin/package.json`).
3. Im Konfigurationsmenü: Miniserver auswählen, Panel(s) anlegen, Räume/
   Controls zuordnen.
4. "An Panel senden" — schreibt die passenden MQTT-Topics auf das Panel und
   löst einen Neustart aus.

## Audio: Sonn Core oder echter Loxone Audioserver

Für Audio-Zonen reicht die Angabe von Host + Zonen-Nummer (`audioserver_host`/
`audioserver_zone` in `config/bridge.json`) — die Bridge liest den
Wiedergabestatus per WebSocket (`:7091`) und sendet Transport-Kommandos per
HTTP (`:7090`), unabhängig davon, ob dahinter ein echter Audioserver oder
Sonn Core (das gegenüber dem Miniserver einen vollwertigen AudioZoneV2
emuliert) steckt — beide sprechen dasselbe Protokoll auf denselben Ports.

**Stand 2026-09:** verifiziert gegen Sonn Cores Emulation; gegen echte
Loxone-Audioserver-Hardware noch nicht getestet (keine Testhardware
verfügbar) — sollte nach aktuellem Kenntnisstand identisch funktionieren,
ist aber noch nicht bestätigt.

## Lizenz / Drittanbieter-Bibliotheken

Dieses Projekt steht unter der [MIT-Lizenz](LICENSE). Verwendete
Open-Source-Abhängigkeiten der Node.js-Bridge samt jeweiliger Lizenz siehe
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
