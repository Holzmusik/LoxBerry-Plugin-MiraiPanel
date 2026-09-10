'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const mqtt = require('mqtt');
const { getAudioserverClient } = require('./audioserver');

// ── Pfade: LoxBerry vs. lokale Entwicklung ─────────────────
// Auf dem LoxBerry liegen bin/, config/, data/ und log/ in
// getrennten Systemverzeichnissen; im Entwicklungs-Checkout
// sind sie Geschwister-Ordner neben bin/.
const LBHOMEDIR = process.env.LBHOMEDIR || '';
const PLUGIN_FOLDER = path.basename(__dirname); // 'miraibridge' auf LoxBerry, 'bin' lokal
const PATHS = LBHOMEDIR
  ? {
      cfg:  path.join(LBHOMEDIR, 'config', 'plugins', PLUGIN_FOLDER, 'bridge.json'),
      data: path.join(LBHOMEDIR, 'data',   'plugins', PLUGIN_FOLDER),
    }
  : {
      cfg:  path.join(__dirname, '..', 'config', 'bridge.json'),
      data: path.join(__dirname, '..', 'data'),
    };

const CFG_FILE = PATHS.cfg;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch (e) {
    console.error('[config] Fehler beim Laden (', CFG_FILE, '):', e.message);
    process.exit(1);
  }
}

const cfg = loadConfig();

// ── Miniserver- und MQTT-Zugangsdaten aus der LoxBerry-Systemkonfiguration ──
// Das Plugin speichert nur die Miniserver-Nummer (msno); Host/User/Pass für
// Miniserver und MQTT-Broker stammen aus general.json (Miniserver-Widget bzw.
// MQTT-Gateway-Plugin), damit sie nicht doppelt gepflegt werden müssen.
function readGeneralJson() {
  const LBHOMEDIR = process.env.LBHOMEDIR || '/opt/loxberry';
  const generalPath = path.join(LBHOMEDIR, 'config', 'system', 'general.json');
  return JSON.parse(fs.readFileSync(generalPath, 'utf8'));
}

function loadMiniserverConn(msno) {
  if (!msno) throw new Error('Keine Miniserver-Nummer (loxone.msno) in bridge.json konfiguriert');
  const general = readGeneralJson();

  // LoxBerry 4.x general.json: Miniserver-Objekt, Keys 1-indexiert als Strings.
  // Feldnamen: Ipaddress, Port, Admin_raw, Pass_raw (verifiziert mit LoxBerry 4.x)
  const msSection = general.Miniserver || general.Miniservers;
  const ms = msSection && (msSection[msno] || msSection[String(msno)]);
  if (!ms) throw new Error(`Miniserver #${msno} nicht in LoxBerry general.json gefunden`);

  const host = ms.Ipaddress || ms.IPAddress;
  if (!host) throw new Error(`Miniserver #${msno}: IP-Adresse nicht gefunden`);

  return {
    host,
    port: ms.Port   || 80,
    user: ms.Admin_raw || ms.Admin || '',
    pass: ms.Pass_raw  || ms.Pass  || '',
  };
}

function loadMqttConn() {
  const general = readGeneralJson();
  const m = general.Mqtt;
  if (!m || !m.Brokerhost) throw new Error('MQTT Gateway ist in LoxBerry nicht konfiguriert (general.json → Mqtt.Brokerhost)');
  return {
    host: m.Brokerhost,
    port: parseInt(m.Brokerport, 10) || 1883,
    user: m.Brokeruser || undefined,
    pass: m.Brokerpass || undefined,
  };
}

// loadMiniserverConn/loadMqttConn werden erst in main() aufgerufen,
// damit Fehler sauber geloggt werden (vorher gab es process.exit(1)
// noch bevor irgendeine Ausgabe in die Log-Datei geschrieben wurde).

// cfg Struktur (bridge.json — MQTT-Broker- und Miniserver-Zugangsdaten stehen
// NICHT hier, sondern in LoxBerrys general.json, siehe loadMiniserverConn/loadMqttConn):
// {
//   "loxone": { "msno": 1 },
//   "panels": [
//     {
//       "name": "miraipanel",          // ESPHome device name (MQTT target)
//       "room_uuid": "...",            // Loxone Raum-UUID
//       "controls": {                  // UUID → Typ-Mapping (aus LoxAPP3.json)
//         "<uuid>": { "type": "IRoomControllerV2", "widget": "content_heating" },
//         "<uuid>": { "type": "Jalousie",            "widget": "content_blinds1" }, // Pool, bis zu 4 Instanzen (content_blinds1-4)
//         "<uuid>": { "type": "AudioZoneV2",        "widget": "content_Audio_small" },
//         "<uuid>": { "type": "LightControllerV2",  "widget": "content_light"  }
//       },
//       "topic_prefix": "loxone/"     // Prefix der Loxone-MQTT-Topics
//     }
//   ]
// }

// ── Loxone Struktur laden ──────────────────────────────────
function fetchLoxStructure(lox) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${lox.user}:${lox.pass}`).toString('base64');
    const options = {
      host: lox.host,
      port: lox.port || 80,
      path: '/data/LoxAPP3.json',
      headers: { 'Authorization': 'Basic ' + auth }
    };
    http.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── State-UUID-Filter aus LoxAPP3.json aufbauen ────────────
// Liest alle in bridge.json konfigurierten Control-UUIDs, sucht deren
// State-Variablen in LoxAPP3.json und gibt ein Set der relevanten
// State-UUIDs zurück. Nur diese werden von Loxone nach MQTT weitergeleitet.
function buildStateFilter(cfg, loxStructure) {
  const stateUuids = new Set(); // state-uuid → MQTT-Topic
  if (!loxStructure || !loxStructure.controls) return stateUuids;

  const loxControls = loxStructure.controls;

  for (const panel of cfg.panels || []) {
    for (const controlUuid of Object.keys(panel.controls || {})) {
      const loxCtrl = loxControls[controlUuid] || loxControls[controlUuid.toLowerCase()];
      if (!loxCtrl || !loxCtrl.states) {
        console.warn(`[bridge] Control ${controlUuid} nicht in LoxAPP3.json — übersprungen`);
        continue;
      }
      for (const stateUuid of Object.values(loxCtrl.states)) {
        stateUuids.add(stateUuid.toLowerCase());
      }
      // Subcontrols (z.B. LightControllerV2 → ".../masterValue") haben eigene
      // states-Objekte, die hier separat mit aufgenommen werden müssen — sonst
      // filtert buildStateFilter() ihre State-UUIDs heraus, obwohl api.php
      // build_topics() genau solche Subcontrol-States als t_*-Topic verwendet
      // (z.B. t_light_master). Loxone sendet den Wert dann zwar, die Bridge
      // verwirft ihn aber lautlos (siehe publishState()'s stateFilter-Check).
      for (const sub of Object.values(loxCtrl.subControls || {})) {
        for (const stateUuid of Object.values(sub.states || {})) {
          stateUuids.add(stateUuid.toLowerCase());
        }
      }
    }

    // sleep_cmd_uuid ist ein Loxone-Schalter (Switch/TimedSwitch) — der
    // relevante Zustand ist states.active (0/1), nicht states.value.
    // Wenn die UUID direkt eine State-UUID ist (kein Control-Treffer), wird
    // sie unverändert übernommen (rückwärtskompatibel).
    const sleepUuid = panel['sleep_cmd_uuid'];
    if (sleepUuid) {
      const loxCtrl = loxControls[sleepUuid] || loxControls[String(sleepUuid).toLowerCase()];
      const stateUuid = (loxCtrl && loxCtrl.states && (loxCtrl.states.active || loxCtrl.states.value)) || sleepUuid;
      stateUuids.add(String(stateUuid).toLowerCase());
    }

    // notify_cmd_uuid bleibt wie bisher (InfoOnly/value-basiert)
    const notifyUuid = panel['notify_cmd_uuid'];
    if (notifyUuid) {
      const loxCtrl = loxControls[notifyUuid] || loxControls[String(notifyUuid).toLowerCase()];
      const stateUuid = (loxCtrl && loxCtrl.states && loxCtrl.states.value) || notifyUuid;
      stateUuids.add(String(stateUuid).toLowerCase());
    }
  }

  // Globale Werte (Zeit & Außenklima, siehe Einstellungen-Tab) — einfache
  // Info-Controls (InfoOnlyAnalog/TextState), bei denen uuidAction meist mit
  // states.value übereinstimmt. Falls die Struktur ein explizites states.value
  // liefert, das nehmen — sonst die UUID direkt (deckt beide Fälle ab).
  for (const uuid of Object.values(cfg.global || {})) {
    if (!uuid) continue;
    const loxCtrl = loxControls[uuid] || loxControls[String(uuid).toLowerCase()];
    const stateUuid = (loxCtrl && loxCtrl.states && loxCtrl.states.value) || uuid;
    stateUuids.add(String(stateUuid).toLowerCase());
  }

  return stateUuids;
}

// ── Echter Loxone Audioserver ODER Sonn Core — reines Protokoll-Routing ────
// 2026-09-10 auf Hardware verifiziert (gegen Sonn Cores Emulation eines
// AudioZoneV2 — ECHTE Loxone-Audioserver-Hardware stand nicht zum Test zur
// Verfügung, siehe Diskussion/[[project_miraipanel_audioserver_bridge]]):
//   - Lesen:   ws://<host>:7091/ws/rfc6455 pusht "audio_event" für alle
//              Zonen einer Box, KEINE Authentifizierung nötig (audioserver.js)
//   - Schreiben: http://<host>:7090/audio/<zone>/play|pause|next|prev|
//              volume/<0-100> — GET reicht, Antwort {"<cmd>_result":[],...}
//              (dieselbe klassische Route, die die Firmware für Favoriten
//              schon nutzt, siehe MiraiPanel-LCD MiraiPanel.yaml roomfav/play)
//
// Bewusst KEINE Loxone-Struktur/UUID-Anbindung nötig — Sonn Core emuliert
// gegenüber dem Miniserver zwar einen vollwertigen AudioZoneV2, aber diese
// beiden Ports antwortet dieselbe Box unabhängig davon direkt, ob dahinter
// Sonn Core oder ein echter Audioserver steckt. Die Bridge muss deshalb nur
// IP + Zonen-Nummer kennen (dieselben Werte, die auf dem Panel unter
// "AudioServer IP"/"AudioServer Zone" ohnehin schon konfiguriert werden) —
// kein Unterschied im Code zwischen Sonn Core und echtem Audioserver V2.
//
// Config pro Panel (bridge.json):
//   "audio_zone_topic":  "mirai/audio/<irgendwas>"  (bereits vorhandenes Feld
//                         — MQTT-Basis-Topic, das die Firmware kennt)
//   "audioserver_host":  "192.168.179.14"           (neu)
//   "audioserver_zone":  5                           (neu — playerid der Zone)
// Panels ohne audioserver_host/audioserver_zone werden übersprungen (Sonn
// Core publiziert dann wie bisher direkt selbst, ohne dass diese Bridge
// überhaupt beteiligt ist).
function setupAudioZones(cfg, mqttClient) {
  const zones = []; // { topicBase, host, httpPort, zoneNum, panelName }

  for (const panel of cfg.panels || []) {
    const host = panel.audioserver_host;
    const zoneNum = panel.audioserver_zone;
    const topicBase = panel.audio_zone_topic;
    if (!host || zoneNum === undefined || zoneNum === null || !topicBase) continue;

    const wsPort = panel.audioserver_ws_port || 7091;
    const httpPort = panel.audioserver_http_port || 7090;
    console.log(`[audio] Panel "${panel.name}": Zone ${zoneNum} @ ${host} <-> ${topicBase}`);

    const client = getAudioserverClient(host, wsPort);
    client.on('zone', (pid, state) => {
      if (String(pid) !== String(zoneNum) || !mqttClient.connected) return;
      mqttClient.publish(`${topicBase}/source/name`, state.station || state.name, { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/track/title`,   state.title,  { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/track/artist`,  state.artist, { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/track/album`,   state.album,  { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/track/coverUrl`, state.cover, { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/state`,  state.playing ? 'playing' : 'paused', { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/volume`, String(state.volume),   { qos: 0, retain: true });
      mqttClient.publish(`${topicBase}/elapsed`,  String(state.time),     { qos: 0, retain: false });
      mqttClient.publish(`${topicBase}/duration`, String(state.duration), { qos: 0, retain: false });
    });

    zones.push({ topicBase, host, httpPort, zoneNum, panelName: panel.name });
  }

  if (zones.length === 0) return;

  // Re-Abo bei jedem (Re-)Connect, analog zum bestehenden loxCmdTopic-Muster
  // weiter unten in main().
  mqttClient.on('connect', () => {
    for (const z of zones) {
      const cmdTopic = `${z.topicBase}/set/+`;
      mqttClient.subscribe(cmdTopic, { qos: 0 }, (err) => {
        if (err) console.error(`[audio] Abo von ${cmdTopic} fehlgeschlagen:`, err.message);
        else console.log(`[audio] Panel-Kommandos abonniert: ${cmdTopic}`);
      });
    }
  });

  // Kommando-Topics/Payloads exakt wie von der Firmware publiziert (siehe
  // MiraiPanel-LCD MiraiPanel.yaml audio_http_play/pause/next/prev/vol_up/
  // vol_down — "von Sonn Core dokumentierte MQTT-Transportbefehle") — hier
  // 1:1 auf die klassische Port-7090-Route gemappt statt auf Sonn Cores
  // eigenes MQTT-Handling.
  mqttClient.on('message', (topic, message) => {
    const zone = zones.find((z) => topic.startsWith(`${z.topicBase}/set/`));
    if (!zone) return;
    const sub = topic.substring(`${zone.topicBase}/set/`.length);
    const payload = message.toString();
    let cmdPath;
    switch (sub) {
      case 'state':    cmdPath = payload === 'playing' ? 'play' : 'pause'; break;
      case 'next':     cmdPath = 'next'; break;
      case 'previous': cmdPath = 'prev'; break;
      case 'volume': {
        const vol = Math.max(0, Math.min(100, parseInt(payload, 10) || 0));
        cmdPath = `volume/${vol}`;
        break;
      }
      default:
        console.warn(`[audio] Unbekanntes Kommando-Subtopic: ${sub} (${zone.panelName})`);
        return;
    }
    sendAudioserverCommand(zone.host, zone.httpPort, zone.zoneNum, cmdPath);
  });
}

// GET http://<host>:<port>/audio/<zone>/<cmdPath> — auf Hardware verifiziert
// (siehe Kommentar oben), Antwort z.B. {"play_result":[],"command":"audio/5/play"}.
// Reine GET-Anfrage reicht, Body wird nicht ausgewertet (nur Statuscode fürs Log).
function sendAudioserverCommand(host, port, zone, cmdPath) {
  const url = `http://${host}:${port}/audio/${zone}/${cmdPath}`;
  http.get(url, (res) => {
    res.resume(); // Antwort muss konsumiert werden, sonst hält http.get den Socket offen.
    console.log(`[audio] ${url} -> HTTP ${res.statusCode}`);
  }).on('error', (e) => console.error(`[audio] Kommando fehlgeschlagen (${url}):`, e.message));
}

// ── Loxone Binary-Protokoll: UUID aus 16 Bytes rekonstruieren ──
// Loxone speichert UUIDs als: D1(4 Byte LE) + D2(2 Byte LE) + D3(2 Byte LE) + D4(8 Byte BE)
// Beispiel: "1236c0e4-0251-4285-ffff825f2d0084ef"
function loxUuidFromBytes(buf) {
  const d1 = buf.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = buf.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = buf.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = buf.slice(8, 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}`;
}

// ── Haupt-Loop ─────────────────────────────────────────────
async function main() {
  console.log('[bridge] MiraiBridge startet');
  console.log('[bridge] CFG_FILE:', CFG_FILE);
  console.log('[bridge] PATHS.data:', PATHS.data);

  // Verbindungsdaten laden — hier, damit Fehler sauber in den Log kommen
  const loxConn  = loadMiniserverConn(cfg.loxone && cfg.loxone.msno);
  const mqttConn = loadMqttConn();
  console.log(`[bridge] Miniserver: ${loxConn.host}:${loxConn.port}`);
  console.log(`[bridge] MQTT-Broker: ${mqttConn.host}:${mqttConn.port}`);

  // Loxone Struktur einmalig laden
  let loxStructure = null;
  try {
    loxStructure = await fetchLoxStructure(loxConn);
    console.log('[bridge] LoxAPP3.json geladen');
    const cachePath = path.join(PATHS.data, 'lox_structure.json');
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(loxStructure, null, 2));
  } catch (e) {
    console.warn('[bridge] LoxAPP3.json nicht erreichbar:', e.message);
  }

  // Miniserver-Seriennummer aus LoxAPP3.json — wird Teil der MQTT-Topics
  const msSerial = (loxStructure && loxStructure.msInfo && loxStructure.msInfo.serialNr)
                    || String(cfg.loxone.msno);

  // State-UUID-Filter: nur konfigurierte Controls + globale Werte forwarden
  // (nicht alles wie lox2mqtt)
  const stateFilter = buildStateFilter(cfg, loxStructure);
  const controlCount = cfg.panels.reduce((s, p) => s + Object.keys(p.controls || {}).length, 0);
  const globalCount  = Object.values(cfg.global || {}).filter(Boolean).length;
  console.log(`[bridge] ${stateFilter.size} State-UUIDs aus ${controlCount} Controls + ${globalCount} globalen Werten aktiv`);
  if (stateFilter.size > 0) {
    // Alle aktiven Topics einmalig beim Start ausgeben
    for (const uuid of stateFilter) {
      console.log(`[topics] mirai/lox/${msSerial}/${uuid}`);
    }
  } else {
    console.warn('[bridge] Keine State-UUIDs — bitte Panel mit echten Loxone-Controls konfigurieren');
  }

  // ── MQTT Client ──────────────────────────────────────────
  const mqttClient = mqtt.connect({
    host:     mqttConn.host,
    port:     mqttConn.port,
    username: mqttConn.user,
    password: mqttConn.pass,
    clientId: 'mirai-bridge',
    clean:    true,
    reconnectPeriod: 5000,
  });

  // Echter Audioserver / Sonn Core: reines IP+Zone-Routing, unabhängig von
  // der Loxone-Struktur (siehe setupAudioZones()-Kommentar) — registriert
  // bei Bedarf eigene 'connect'/'message'-Listener auf mqttClient, no-op
  // falls kein Panel audioserver_host/audioserver_zone konfiguriert hat.
  setupAudioZones(cfg, mqttClient);

  // Panel → Loxone: die Firmware schreibt (Sensor-Werte, Heizung-Sollwert,
  // Jalousie-Up/Down-Pulse etc.) immer auf "<Topic_LoxPrefix><ziel-uuid>/cmd"
  // (siehe MiraiPanel-LCD/MiraiPanel.yaml, z.B. RoomTemperature-Sensor-Handler).
  // Topic_LoxPrefix wird von uns selbst auf "mirai/lox/<serial>/" gesetzt
  // (siehe api.php build_topics/"lox_prefix"), die Bridge muss also genau
  // dieses Schema abonnieren, nicht ein eigenes.
  const loxCmdTopic = `mirai/lox/${msSerial}/+/cmd`;

  mqttClient.on('connect', () => {
    console.log('[mqtt] Verbunden mit Broker');
    mqttClient.subscribe(loxCmdTopic, { qos: 0 }, (err) => {
      if (err) console.error(`[mqtt] Abo von ${loxCmdTopic} fehlgeschlagen:`, err.message);
      else console.log(`[mqtt] Panel-Kommandos abonniert: ${loxCmdTopic}`);
    });
  });

  // Panel → Loxone ist bewusst ungefiltert: JEDE UUID, die das Panel unter
  // diesem Topic-Schema published (Sensorwerte, Heizung-Sollwert, Jalousie-
  // Puls, Tastendruck, Audio-Kommando, ...), wird 1:1 an Loxone weitergereicht
  // — anders als bei publishState() gibt es hier keine Allowlist, weil wir
  // per Wildcard-Abo sowieso nur exakt das empfangen, was die Firmware selbst
  // unter mirai/lox/<serial>/+/cmd sendet.
  mqttClient.on('message', (topic, message) => {
    const cmdMatch = topic.match(/^mirai\/lox\/([^/]+)\/([^/]+)\/cmd$/);
    if (!cmdMatch) {
      console.warn(`[cmd] Unerwartetes Topic ignoriert: ${topic}`);
      return;
    }
    if (cmdMatch[1] !== msSerial) {
      console.warn(`[cmd] Serial-Mismatch ignoriert: ${topic} (erwartet ${msSerial})`);
      return;
    }
    sendToLoxone(cmdMatch[2], message.toString());
  });

  // ── Loxone WebSocket: eigene Implementierung (Token-Auth + Binary-Parser) ─
  // Kein externes Loxone-Paket — alles selbst implementiert, nur 'ws' + built-in
  // 'crypto' nötig.

  const publishedOnce = new Set();
  function publishState(uuid, value) {
    const key = uuid.toLowerCase();
    if (!stateFilter.has(key)) return;
    if (!mqttClient.connected) return;
    const topic = `mirai/lox/${msSerial}/${key}`;
    mqttClient.publish(topic, String(value), { qos: 0, retain: true });
    if (!publishedOnce.has(key)) {
      publishedOnce.add(key);
      console.log(`[state] ${topic} = ${String(value).substring(0, 80)}`);
    }
  }

  // ── Loxone via node-lox-ws-api (Token-Enc = RSA+AES, identisch zu lox2mqtt) ─
  const LoxoneAPI = require('node-lox-ws-api');

  const loxApi = new LoxoneAPI(
    `${loxConn.host}:${loxConn.port || 80}`,
    loxConn.user,
    loxConn.pass,
    true,        // auto-reconnect
    'Token-Enc', // RSA+AES-verschlüsselte Token-Auth (Firmware 9.x+)
    30000
  );

  // Merkt, ob die Loxone-WS-Verbindung aktuell authentifiziert ist — Befehle,
  // die davor ankommen (z.B. Panel published direkt nach eigenem Boot,
  // während die Bridge noch verbindet), würden sonst stillschweigend verloren
  // gehen, ohne dass das im Log auftaucht.
  let loxAuthorized = false;
  loxApi.on('authorized',      () => { loxAuthorized = true; console.log('[lox] Authentifiziert ✓'); });
  loxApi.on('auth_failed',     () => { loxAuthorized = false; console.error('[lox] Authentifizierung fehlgeschlagen'); });
  loxApi.on('connect_failed',  () => { loxAuthorized = false; console.error('[lox] Verbindung fehlgeschlagen'); });
  loxApi.on('connection_error',(e) => console.error('[lox] Fehler:', e && e.message || e));
  loxApi.on('close',           () => { loxAuthorized = false; console.warn('[lox] Verbindung getrennt'); });
  loxApi.on('reconnect',       () => console.log('[lox] Reconnect…'));

  // ── Latenz-Messung: MQTT-Befehl empfangen → Loxone meldet neue State ──
  // uuid → Zeitpunkt (ms) des letzten gesendeten Befehls für diese UUID.
  // Wird beim Senden gesetzt, beim passenden Rückmelde-Event ausgelesen und
  // gelöscht. Loxone sendet State-Updates für ALLE Controls (nicht nur die
  // im stateFilter erlaubten), daher funktioniert das auch für Ziele wie
  // Sensor-Ziele, die die Bridge sonst nicht nach MQTT weiterleitet.
  const pendingCommands = new Map();

  function handleLoxUpdate(uuid, value) {
    const key = uuid.toLowerCase();
    const sentAt = pendingCommands.get(key);
    if (sentAt !== undefined) {
      pendingCommands.delete(key);
      console.log(`[latenz] ${key}: ${Date.now() - sentAt}ms (MQTT-Befehl → Loxone-Rückmeldung)`);
    }
    publishState(uuid, value);
  }

  loxApi.on('update_event_value', (uuid, value) => handleLoxUpdate(uuid, value));
  loxApi.on('update_event_text',  (uuid, text)  => handleLoxUpdate(uuid, text));

  // Manche Topic_*-Felder in der Firmware haben nie eine echte UUID bekommen
  // und stehen noch auf dem Platzhalter-Default aus globals.yaml (z.B.
  // "Topic_Mic", falls "Mikrofon / Geräusch" im Panel nicht konfiguriert
  // wurde). Solche Werte werden trotzdem published — ohne diese Prüfung
  // würde die Bridge sinnlos "jdev/sps/io/topic_mic/…" an Loxone schicken.
  const LOX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{16}$/i;

  // node-lox-ws-api's send_command() hat keinerlei Fehlerbehandlung/Rückgabe
  // (kein Callback, kein Promise, keine Prüfung ob die Verbindung überhaupt
  // steht) — ein interner Fehler (z.B. Verbindung/Auth noch nicht bereit)
  // geht sonst komplett lautlos unter. Deshalb hier explizit absichern und
  // is_connected() vorab prüfen.
  function sendToLoxone(uuid, value) {
    const key = uuid.toLowerCase();
    if (!LOX_UUID_RE.test(key)) {
      console.warn(`[cmd] Ziel sieht nicht wie eine echte Loxone-UUID aus, übersprungen: "${key}" = ${value} — vermutlich unkonfiguriertes Topic_*-Feld im Panel (siehe Einstellungen/Sensor-Ziele)`);
      return;
    }
    if (!loxAuthorized) {
      console.warn(`[cmd] Noch nicht bei Loxone authentifiziert — Befehl trotzdem versucht: ${key} = ${value}`);
    }
    if (typeof loxApi.is_connected === 'function' && !loxApi.is_connected()) {
      console.error(`[cmd] Keine Loxone-Verbindung — Befehl verworfen: ${key} = ${value}`);
      return;
    }
    console.log(`[cmd] jdev/sps/io/${key}/${value}`);
    try {
      pendingCommands.set(key, Date.now());
      loxApi.send_command(`jdev/sps/io/${key}/${value}`);
    } catch (e) {
      pendingCommands.delete(key);
      console.error(`[cmd] send_command fehlgeschlagen für ${key}:`, e && e.message || e);
    }
  }

  console.log(`[lox] Verbinde mit ${loxConn.host}:${loxConn.port || 80}…`);
  loxApi.connect();
}

main().catch(e => {
  console.error('[bridge] Fataler Fehler:', e);
  process.exit(1);
});
