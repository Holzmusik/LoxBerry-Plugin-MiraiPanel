'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

// ── Direkte Verbindung zum echten Loxone Audioserver (nicht zum Miniserver) ─
// Auf Hardware verifiziert (2026-09-10, siehe audioserver_probe.js-Läufe):
// ws://<host>:7091/ws/rfc6455 pusht nach dem Connect sofort und danach bei
// JEDER Änderung vollständige "audio_event"-Daten für ALLE Zonen der Box —
// Titel/Artist/Album/Cover/Mode/Power/Volume/Time/Duration — komplett OHNE
// Authentifizierung. Der RSA/AES-Handshake, den Loxpanel (als einzige
// verfügbare Referenz, ohne Lizenzangabe — hier bewusst kein Code von dort
// übernommen, nur das Protokoll als Anhaltspunkt genutzt) für seine eigene
// Verbindung nutzt, war für unseren Lesefall unnötig: Kommandos laufen
// ohnehin nicht über diese Verbindung, sondern ganz normal über die
// bestehende Miniserver-Verbindung (jdev/sps/io/<uuid>/<cmd>, siehe
// bridge.js sendToLoxone()).
//
// Ein AudioserverClient pro physischer Box (Host:Port) — mehrere Zonen auf
// derselben Box (Normalfall) teilen sich eine Verbindung, das reduziert
// unnötige Duplicate-Connections wenn mehrere Panels/Zonen denselben
// Audioserver nutzen (siehe getClient() Registry unten).

const RECONNECT_DELAY_MS = 5000;

class AudioserverClient extends EventEmitter {
  constructor(host, port = 7091, wsPath = '/ws/rfc6455') {
    super();
    this.host = host;
    this.port = port;
    this.wsPath = wsPath;
    this.ws = null;
    this.closed = false;
    // playerid -> zuletzt emittierter State, für Dedup (siehe _handleEvent).
    this._lastState = new Map();
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    const url = `ws://${this.host}:${this.port}${this.wsPath}`;
    console.log(`[audioserver] Verbinde zu ${url}`);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => console.log(`[audioserver] ${this.host}: verbunden`));

    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        // Banner-Zeile ("LWSS V...") ist kein JSON — ignorieren, kein Fehler.
        return;
      }
      const events = parsed && parsed.audio_event;
      if (!Array.isArray(events)) return;
      for (const ev of events) this._handleEvent(ev);
    });

    ws.on('error', (e) => console.error(`[audioserver] ${this.host}: WS-Fehler:`, e.message));

    ws.on('close', () => {
      if (this.closed) return;
      console.warn(`[audioserver] ${this.host}: Verbindung getrennt, reconnect in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });
  }

  // Die Box schickt bei jeder Kleinigkeit (auch Sub-Feld-Änderungen) einen
  // vollständigen audio_event-Block für die betroffene Zone erneut — auf
  // Hardware beobachtet teils mehrfach binnen weniger ms mit identischem
  // Inhalt (siehe audioserver_probe.js-Log: #10/#11, #16/#17 fast gleich).
  // Ohne Dedup würde jede Panel-Anzeige unnötig oft neu gerendert und MQTT
  // unnötig oft publiziert (retain+qos0, aber trotzdem unnötiger Traffic).
  _handleEvent(ev) {
    const playerid = ev.playerid;
    if (playerid === undefined || playerid === null) return;

    const state = normalizeEvent(ev);
    const prev = this._lastState.get(playerid);
    if (prev && shallowEqual(prev, state)) return;
    this._lastState.set(playerid, state);

    this.emit('zone', playerid, state);
  }

  close() {
    this.closed = true;
    if (this.ws) this.ws.close();
  }
}

// Rohes audio_event-Feld auf die Teilmenge reduzieren, die uns interessiert
// (siehe Kommentar oben — Feldnamen 1:1 aus echten Hardware-Logs, nicht aus
// Loxone-Doku, die dazu nichts hergibt).
function normalizeEvent(ev) {
  return {
    name: ev.name || '',
    title: ev.title || '',
    artist: ev.artist || '',
    // album ist bei Radio-Streams meist leer — station als Fallback, analog
    // zur bestehenden Firmware-Logik für Sonn Core (siehe MiraiPanel.yaml
    // ov_line3 "album" bei is_radio).
    album: ev.album || ev.station || '',
    station: ev.station || '',
    cover: ev.coverurl || '',
    playing: ev.mode === 'play',
    power: ev.power === 'on',
    volume: typeof ev.volume === 'number' ? ev.volume : 0,
    time: typeof ev.time === 'number' ? ev.time : 0,
    duration: typeof ev.duration === 'number' ? ev.duration : 0,
    shuffle: !!ev.plshuffle,
    repeat: ev.plrepeat || 0,
  };
}

function shallowEqual(a, b) {
  for (const k of Object.keys(a)) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ── Registry: eine Verbindung pro Host:Port, geteilt über alle Panels/Zonen ─
const _clients = new Map();

function getAudioserverClient(host, port = 7091, wsPath = '/ws/rfc6455') {
  const key = `${host}:${port}${wsPath}`;
  let client = _clients.get(key);
  if (!client) {
    client = new AudioserverClient(host, port, wsPath);
    _clients.set(key, client);
  }
  return client;
}

module.exports = { AudioserverClient, getAudioserverClient };
