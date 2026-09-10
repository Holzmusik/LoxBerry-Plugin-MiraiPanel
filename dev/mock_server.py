#!/usr/bin/env python3
"""
MiraiBridge Mock-Server fuer lokale Frontend-Tests (ohne echte LoxBerry/Loxone/MQTT-Umgebung).

Simuliert die Endpunkte aus webfrontend/htmlauth/api.php mit Fake-Daten:
  - config          (GET/POST, persistiert in dev/mock_bridge.json -- NICHT
                      config/bridge.json, siehe Kommentar bei CFG_FILE unten)
  - miniservers      (GET, liefert eine erfundene Liste "in LoxBerry konfigurierter" Miniserver)
  - mqtt_info        (GET, liefert eine erfundene "LoxBerry MQTT-Gateway"-Broker-Adresse)
  - scan_panels      (GET, liefert erfundene per "mirai/+/ip"-Topic gefundene MiraiPanel-Geraete)
  - lox_structure    (GET, liefert eine erfundene LoxAPP3-Struktur mit Raeumen/Controls)
  - lox_test         (GET, immer "ok")
  - send_topics      (POST, baut die t_*-Topics wie api.php build_topics(), loggt nur)
  - bridge_status    (GET, Fake-PID + Fake-Log + Fake-systemctl-Status)
  - bridge_restart   (POST, immer "ok")

Hinweis zu scan_panels: die MiraiPanel-Firmware veroeffentlicht ihre aktuelle
IP (aus EthernetManager::get_ip_str(), retained) selbst unter dem eigenen
Topic "mirai/<name>/ip" — der Scan ist dadurch MiraiPanel-exklusiv und
findet keine fremden ESPHome-Geraete. Der Online-Status kommt ergaenzend aus
ESPHomes Standard-Birth-/LWT-Topic "<name>/status". Der Mock simuliert zwei
online gemeldete MiraiPanel-Treffer und einen (offline).

Hinweis: Auf echter LoxBerry-Hardware kommen Miniserver- UND MQTT-Broker-
Zugangsdaten NICHT aus der Plugin-Config, sondern aus general.json:
  - Miniserver ueber LBSystem::get_miniservers() (PHP) / LoxBerry::System (Perl)
  - MQTT-Broker ueber mqtt_connectiondetails() aus loxberry_io.php (setzt das
    LoxBerry "MQTT Gateway"-Plugin voraus)
Die Plugin-Config speichert nur "loxone.msno" (Miniserver-Nummer). Dieser
Mock-Server tut so, als waeren zwei Miniserver und ein MQTT-Broker in
LoxBerry hinterlegt.

Start:
    python dev/mock_server.py
Dann im Browser:
    http://localhost:8000/
"""
import http.server
import json
import re
import socketserver
import time
import urllib.parse
from pathlib import Path

PORT = 8000
ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "webfrontend" / "htmlauth"
# Eigene Datei statt config/bridge.json: Letzteres ist die "echte" Config, die
# 1:1 mit ins Plugin-Paket (ZIP) wandert. Frueher zeigte der Mock-Server
# hierher, wodurch Test-Panels/-Werte aus lokalen Laeufen wiederholt in die
# ausgelieferte config/bridge.json durchgesickert sind (siehe CHANGELOG.md).
CFG_FILE = ROOT / "dev" / "mock_bridge.json"

FAKE_START_TIME = time.time()

MOCK_MINISERVERS = [
    {"msno": 1, "name": "Hauptserver", "ipaddress": "192.168.179.10"},
    {"msno": 2, "name": "Gartenhaus", "ipaddress": "192.168.179.20"},
]

MOCK_MQTT_BROKER = "192.168.179.12:1883"

MOCK_SCANNED_DEVICES = [
    {"name": "miraipanel-wohnzimmer", "friendly_name": "miraipanel-wohnzimmer", "ip": "192.168.179.55", "online": True},
    {"name": "miraipanel-kueche", "friendly_name": "miraipanel-kueche", "ip": "192.168.179.56", "online": True},
    # Bereits konfiguriertes, aber gerade offline/ausgeschaltetes Panel:
    # "mirai/<name>/ip" ist retained (letzte bekannte IP bleibt sichtbar),
    # "<name>/status" (LWT) meldet aber "offline".
    {"name": "miraipanel-schlafzimmer", "friendly_name": "miraipanel-schlafzimmer", "ip": "192.168.179.57", "online": False},
]

MOCK_LOX_STRUCTURE = {
    "msInfo": {"serialNr": "504F94A0FD49", "msName": "Mock-Miniserver"},
    "rooms": {
        "room-wohnzimmer": {"uuid": "room-wohnzimmer", "name": "Wohnzimmer"},
        "room-schlafzimmer": {"uuid": "room-schlafzimmer", "name": "Schlafzimmer"},
        "room-kueche": {"uuid": "room-kueche", "name": "Kueche"},
    },
    # Wie auf der echten Loxone Miniserver: die UUID ist NUR der Dictionary-
    # Key, die Controls selbst haben kein "uuid"-Feld (nur "uuidAction",
    # das den gleichen Wert wie der Key traegt). Absichtlich so gehalten,
    # damit dieser Mock den echten Bug (index.php nutzte faelschlich
    # ctrl.uuid) reproduziert haette. "states"/"subControls" sind an den
    # echten Feldnamen aus Structure_file.txt orientiert (siehe api.php
    # build_topics()), damit send_topics hier sinnvoll testbar ist.
    "controls": {
        "ctrl-heiz-wz": {
            "uuidAction": "ctrl-heiz-wz", "name": "Heizung Wohnzimmer", "type": "IRoomControllerV2", "room": "room-wohnzimmer",
            "states": {"tempActual": "st-heiz-wz-actual", "tempTarget": "st-heiz-wz-target", "active": "st-heiz-wz-active",
                       "comfortTemperature": "st-heiz-wz-comfort", "activeMode": "st-heiz-wz-mode", "overrideEntries": "st-heiz-wz-override"},
        },
        "ctrl-jal-wz": {
            "uuidAction": "ctrl-jal-wz", "name": "Jalousie Wohnzimmer", "type": "Jalousie", "room": "room-wohnzimmer",
            "states": {"position": "st-jal-wz-pos", "shadePosition": "st-jal-wz-shade", "up": "st-jal-wz-up", "down": "st-jal-wz-down"},
        },
        "ctrl-licht-wz": {
            "uuidAction": "ctrl-licht-wz", "name": "Licht Wohnzimmer", "type": "LightControllerV2", "room": "room-wohnzimmer",
            "states": {"activeMoodsNum": "st-licht-wz-moods", "moodList": "st-licht-wz-list"},
            "subControls": {"ctrl-licht-wz/masterValue": {"name": "Master-Helligkeit", "states": {"position": "st-licht-wz-master"}}},
        },
        "ctrl-audio-wz": {"uuidAction": "ctrl-audio-wz", "name": "Audio Wohnzimmer", "type": "AudioZoneV2", "room": "room-wohnzimmer"},
        "ctrl-heiz-sz": {"uuidAction": "ctrl-heiz-sz", "name": "Heizung Schlafzimmer", "type": "IRoomControllerV2", "room": "room-schlafzimmer",
            "states": {"tempActual": "st-heiz-sz-actual", "tempTarget": "st-heiz-sz-target", "active": "st-heiz-sz-active",
                       "comfortTemperature": "st-heiz-sz-comfort", "activeMode": "st-heiz-sz-mode", "overrideEntries": "st-heiz-sz-override"}},
        "ctrl-jal-sz": {"uuidAction": "ctrl-jal-sz", "name": "Jalousie Schlafzimmer", "type": "Jalousie", "room": "room-schlafzimmer",
            "states": {"position": "st-jal-sz-pos", "shadePosition": "st-jal-sz-shade", "up": "st-jal-sz-up", "down": "st-jal-sz-down"}},
        "ctrl-licht-sz": {"uuidAction": "ctrl-licht-sz", "name": "Deckenlicht Schlafzimmer", "type": "Switch", "room": "room-schlafzimmer"},
        "ctrl-heiz-ku": {"uuidAction": "ctrl-heiz-ku", "name": "Heizung Kueche", "type": "IRoomControllerV2", "room": "room-kueche",
            "states": {"tempActual": "st-heiz-ku-actual", "tempTarget": "st-heiz-ku-target", "active": "st-heiz-ku-active",
                       "comfortTemperature": "st-heiz-ku-comfort", "activeMode": "st-heiz-ku-mode", "overrideEntries": "st-heiz-ku-override"}},
        "ctrl-licht-ku": {"uuidAction": "ctrl-licht-ku", "name": "Licht Kueche", "type": "LightControllerV2", "room": "room-kueche",
            "states": {"activeMoodsNum": "st-licht-ku-moods", "moodList": "st-licht-ku-list"},
            "subControls": {"ctrl-licht-ku/masterValue": {"name": "Master-Helligkeit", "states": {"position": "st-licht-ku-master"}}}},
        "ctrl-sw1-ku": {"uuidAction": "ctrl-sw1-ku", "name": "Kaffeemaschine", "type": "Switch", "room": "room-kueche"},
        "ctrl-sw2-ku": {"uuidAction": "ctrl-sw2-ku", "name": "Dunstabzug", "type": "TimedSwitch", "room": "room-kueche"},
        # Fuer "Globale Werte" (Zeit & Aussenklima) -- an echten Namen/Typen aus
        # Structure_file.txt orientiert: Uhrzeit/Datum/Wochentag sind TextState,
        # Jahr/Luftfeuchtigkeit sind InfoOnlyAnalog (NICHT "Zeit"/"Aussentemperatur").
        "ctrl-uhrzeit": {"uuidAction": "ctrl-uhrzeit", "name": "Uhrzeit", "type": "TextState", "room": None, "states": {"value": "ctrl-uhrzeit"}},
        "ctrl-datum": {"uuidAction": "ctrl-datum", "name": "Datum", "type": "TextState", "room": None, "states": {"value": "ctrl-datum"}},
        "ctrl-wochentag": {"uuidAction": "ctrl-wochentag", "name": "Wochentag", "type": "TextState", "room": None, "states": {"value": "ctrl-wochentag"}},
        "ctrl-jahr": {"uuidAction": "ctrl-jahr", "name": "Jahr", "type": "InfoOnlyAnalog", "room": None, "states": {"value": "ctrl-jahr"}},
        "ctrl-luftfeuchte": {"uuidAction": "ctrl-luftfeuchte", "name": "Luftfeuchtigkeit", "type": "InfoOnlyAnalog", "room": None, "states": {"value": "ctrl-luftfeuchte"}},
        # Virtuelle Eingaenge (Schreibrichtung Panel -> Loxone) -- immer Typ
        # "Slider" mit uuidAction == states.value, siehe Structure_file.txt
        # (z.B. "S1".."S8" fuer Hardware-Tasten, "MV"/"Play"/"Pause" fuer Audio).
        "vi-taste1": {"uuidAction": "vi-taste1", "name": "S1", "type": "Slider", "room": "room-kueche", "states": {"value": "vi-taste1"}},
        "vi-raumtemp": {"uuidAction": "vi-raumtemp", "name": "Raum_Temp", "type": "Slider", "room": "room-kueche", "states": {"value": "vi-raumtemp"}},
        "vi-play": {"uuidAction": "vi-play", "name": "Play", "type": "Slider", "room": "room-kueche", "states": {"value": "vi-play"}},
    },
}


def cfg_load():
    if not CFG_FILE.exists():
        return {"loxone": {"msno": 1}, "global": {}, "panels": []}
    try:
        return json.loads(CFG_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"loxone": {"msno": 1}, "global": {}, "panels": []}


def cfg_save(data):
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# Python-Nachbau von api.php's build_topics(), fuer lokale Tests von
# "Topics senden" ohne echtes MQTT/PHP.
def build_topics(panel, global_cfg, lox_structure):
    controls = lox_structure.get("controls", {})
    topics = {}

    serial = lox_structure.get("msInfo", {}).get("serialNr")
    if serial:
        topics["lox_prefix"] = f"mirai/lox/{serial}/"

    for uuid, mapping in (panel.get("controls") or {}).items():
        ctrl = controls.get(uuid)
        if not ctrl:
            continue
        states = ctrl.get("states", {})
        ctype = mapping.get("type")
        if ctype == "IRoomControllerV2":
            topics["t_heat_cmd"] = ctrl.get("uuidAction", "")
            topics["t_heat_actual"] = states.get("tempActual", "")
            topics["t_heat_target"] = states.get("tempTarget", "")
            topics["t_heat_active"] = states.get("active", "")
            topics["t_heat_comfort"] = states.get("comfortTemperature", "")
            topics["t_heat_mode"] = states.get("activeMode", "")
            topics["t_heat_override_entries"] = states.get("overrideEntries", "")
        elif ctype == "Jalousie":
            # Jalousie-Pool (max. 4 Instanzen) — Index kommt aus dem
            # zugewiesenen Widget-Slot, siehe api.php build_topics().
            blinds_nums = {"content_blinds1": 1, "content_blinds2": 2, "content_blinds3": 3, "content_blinds4": 4}
            blinds_num = blinds_nums.get(mapping.get("widget"))
            if blinds_num is not None:
                topics[f"t_blinds_pos_{blinds_num}"] = states.get("position", "")
                topics[f"t_blinds_shade_{blinds_num}"] = states.get("shadePosition", "")
                topics[f"t_blinds_up_{blinds_num}"] = states.get("up", "")
                topics[f"t_blinds_down_{blinds_num}"] = states.get("down", "")
        elif ctype == "LightControllerV2":
            topics["t_light_moods"] = states.get("activeMoodsNum", "")
            topics["t_light_list"] = states.get("moodList", "")
            topics["t_light_cmd"] = ctrl.get("uuidAction", "")
            for sub_key, sub in (ctrl.get("subControls") or {}).items():
                if sub_key.endswith("/masterValue"):
                    topics["t_light_master"] = sub.get("states", {}).get("position", "")
                    break

    for i, uuid in enumerate(panel.get("hw_keys") or []):
        if uuid:
            topics[f"t_sw{i + 1}"] = uuid

    sensor_map = {
        "room_temp": "t_rt", "room_humidity": "t_rh", "co2": "t_co2", "voc": "t_voc",
        "pir": "t_pir", "mic": "t_mic", "brightness": "t_brightness",
        "lux": "t_lux", "power": "t_supply_power",
    }
    for key, uuid in (panel.get("sensor_targets") or {}).items():
        if uuid and key in sensor_map:
            topics[sensor_map[key]] = uuid

    if panel.get("audio_zone_topic"):
        topics["t_audio_zone"] = panel["audio_zone_topic"]
    if panel.get("buzzer_topic"):
        topics["t_buzzer_warning"] = panel["buzzer_topic"]
    if panel.get("sleep_cmd_uuid"):
        topics["t_sleep_cmd"] = panel["sleep_cmd_uuid"]
    if panel.get("notify_cmd_uuid"):
        topics["t_notify_cmd"] = panel["notify_cmd_uuid"]
    if panel.get("weather_topic_prefix"):
        topics["t_weather_prefix"] = panel["weather_topic_prefix"]

    global_map = {
        "time_uuid": "t_time", "date_uuid": "t_date", "dow_uuid": "t_dow",
        "year_uuid": "t_year", "outside_temp_uuid": "t_outside_temp",
        "outside_humidity_uuid": "t_outside_hum",
    }
    for key, uuid in (global_cfg or {}).items():
        if uuid and key in global_map:
            topics[global_map[key]] = uuid

    return topics


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(FRONTEND_DIR), **kwargs)

    def log_message(self, fmt, *args):
        print("[mock-server] " + (fmt % args))

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.endswith("api.php"):
            qs = urllib.parse.parse_qs(parsed.query)
            action = (qs.get("action") or [""])[0]
            return self._handle_action(action, "GET")
        if parsed.path in ("/", "/index.php"):
            return self._serve_index_php()
        return super().do_GET()

    def _serve_index_php(self):
        # index.php enthaelt echten PHP-Code (LBWeb::lbheader()/lbfooter()),
        # der nur auf echter LoxBerry-Hardware laeuft. Fuer den lokalen Test
        # schneiden wir die <?php ... ?>-Bloecke einfach raus und liefern den
        # Rest (unser eigentliches UI) in einem minimalen HTML-Grundgeruest.
        # Der echte LoxBerry-Rahmen (Header/Sidebar) ist damit NICHT geprueft.
        source = (FRONTEND_DIR / "index.php").read_text(encoding="utf-8")
        body = re.sub(r"<\?php.*?(?:\?>|\Z)", "", source, flags=re.DOTALL)
        html = (
            "<!DOCTYPE html><html lang=\"de\"><head><meta charset=\"UTF-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<title>MiraiBridge (Mock, ohne LoxBerry-Rahmen)</title></head><body>"
            + body + "</body></html>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.endswith("api.php"):
            qs = urllib.parse.parse_qs(parsed.query)
            action = (qs.get("action") or [""])[0]
            return self._handle_action(action, "POST")
        return self._json({"error": "not found"}, 404)

    def _handle_action(self, action, method):
        if action == "config":
            if method == "POST":
                cfg_save(self._read_body())
                return self._json({"ok": True})
            return self._json(cfg_load())

        if action == "miniservers":
            return self._json(MOCK_MINISERVERS)

        if action == "mqtt_info":
            return self._json({"broker": MOCK_MQTT_BROKER})

        if action == "scan_panels":
            return self._json(MOCK_SCANNED_DEVICES)

        if action == "lox_structure":
            return self._json(MOCK_LOX_STRUCTURE)

        if action == "lox_test":
            return self._json({"ok": True})

        if action == "send_topics":
            body = self._read_body()
            panel_name = body.get("panel_name", "?")
            cfg = cfg_load()
            panel = next((p for p in cfg.get("panels", []) if p.get("name") == panel_name), None)
            if not panel:
                return self._json({"error": "Panel nicht gefunden"}, 400)
            topics = build_topics(panel, cfg.get("global", {}), MOCK_LOX_STRUCTURE)
            print(f"[mock] send_topics an Panel '{panel_name}': {json.dumps(topics, ensure_ascii=False)}")
            return self._json({"ok": True, "topics": topics})

        if action == "bridge_status":
            uptime = int(time.time() - FAKE_START_TIME)
            log = (
                "[mock] bridge.js gestartet (Fake)\n"
                "[mock] LoxAPP3.json geladen\n"
                "[mock] mqtt verbunden mit Fake-Broker\n"
                f"[mock] laeuft seit {uptime}s\n"
            )
            return self._json({"running": True, "pid": 99999, "status": "active", "log": log})

        if action == "bridge_restart":
            print("[mock] bridge_restart aufgerufen (echt: sudo systemctl restart miraibridge)")
            return self._json({"ok": True, "out": "[mock] systemctl restart miraibridge"})

        return self._json({"error": "Unbekannte Aktion"}, 404)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main():
    if not FRONTEND_DIR.exists():
        raise SystemExit(f"Frontend-Verzeichnis nicht gefunden: {FRONTEND_DIR}")
    with ReusableTCPServer(("", PORT), Handler) as httpd:
        print(f"MiraiBridge Mock-Server laeuft auf http://localhost:{PORT}/")
        print(f"Config-Datei: {CFG_FILE}")
        print("Zum Beenden: Strg+C")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
