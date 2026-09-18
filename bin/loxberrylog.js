'use strict';

// Macht LoxBerrys nativen, pro-Plugin einstellbaren "Log-Level"-Schalter
// (Plugin-Verwaltung, aktiviert durch CUSTOM_LOGLEVELS=true in plugin.cfg)
// fuer diese Node-Bridge nutzbar. Gleicher Mechanismus/gleiche Begruendung
// wie im Schwester-Plugin EaseeMQTT (daemon/internal/loxberrylog/
// loxberrylog.go, dort ausfuehrlich dokumentiert) und 1:1 identisch mit
// KNXtoLOX/bin/loxberrylog.js: der Schalter ist eingebaut ein reines
// Perl/PHP-Feature (LoxBerry::Log.pm), es gibt KEIN offizielles Node-
// Aequivalent im LoxBerry-Core. Der gewaehlte Wert landet in der vom Core
// selbst verwalteten Datei $LBHOMEDIR/data/system/plugindatabase.json, als
// Feld "loglevel" (0=Off, 3=Error, 4=Warning, 6=Info, 7=Debug) innerhalb
// des per Plugin-Ordnername identifizierten Eintrags unter "plugins" -
// wird hier direkt selbst gelesen und alle ~60s neu geladen (gleiches
// Intervall wie LoxBerry::Log.pm intern), damit eine Aenderung des
// Dropdowns ohne Neustart der Bridge wirkt.

const fs = require('fs');
const path = require('path');

const OFF = 0;
const ERROR = 3;
const WARNING = 4;
const INFO = 6;
const DEBUG = 7;

// defaultLevel: derselbe sichere Fallback wie auf der Go-Seite - solange
// plugindatabase.json (noch) nicht gelesen werden konnte, oder der eigene
// Plugin-Eintrag darin nicht gefunden wird (z.B. lokaler Testlauf ohne
// echte LoxBerry-Umgebung).
const defaultLevel = ERROR;

function create(pluginFolder, lbHomeDir) {
  const home = lbHomeDir || process.env.LBHOMEDIR || '/opt/loxberry';
  const dbPath = path.join(home, 'data', 'system', 'plugindatabase.json');

  let level = defaultLevel;

  function refresh() {
    let raw;
    try {
      raw = fs.readFileSync(dbPath, 'utf8');
    } catch (e) {
      return; // Datei (noch) nicht da/lesbar - beim zuletzt bekannten Level bleiben
    }
    let db;
    try {
      db = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const plugins = (db && db.plugins) || {};
    for (const key of Object.keys(plugins)) {
      const entry = plugins[key];
      if (!entry || entry.folder !== pluginFolder) continue;
      // loglevels_enabled=0 (oder Feld fehlt) bedeutet: CUSTOM_LOGLEVELS war
      // beim Install nicht aktiv, oder der gespeicherte Wert ist der
      // PluginDB.pm-Sentinel "-1" - in beiden Faellen bleibt der sichere
      // Default bestehen statt ein unsinniger/negativer Wert uebernommen zu
      // werden.
      if (entry.loglevels_enabled === 0 || entry.loglevels_enabled === '0') return;
      const lvl = Number(entry.loglevel);
      if (Number.isInteger(lvl) && lvl >= OFF && lvl <= DEBUG) level = lvl;
      return;
    }
  }

  refresh();
  const timer = setInterval(refresh, 60000);
  if (timer.unref) timer.unref(); // haelt den Prozess nicht unnoetig am Leben

  return {
    OFF, ERROR, WARNING, INFO, DEBUG,
    level: () => level,
    // Gleiche Syslog-aehnliche Semantik wie LoxBerry selbst: eine Meldung
    // wird gezeigt, wenn das konfigurierte Level >= ihrer eigenen
    // Dringlichkeit ist.
    enabled: (msgLevel) => level >= msgLevel,
  };
}

module.exports = { create, OFF, ERROR, WARNING, INFO, DEBUG };
