# Third-Party Notices

Die `miraibridge`-Bridge (`bin/`) bindet folgende Open-Source-Bibliotheken
ein. Diese Datei listet die direkten Abhängigkeiten aus `bin/package.json`
mitsamt Lizenz; der jeweilige Lizenztext ist beim Originalprojekt verlinkt.

| Modul | Lizenz | Projekt |
|---|---|---|
| mqtt | MIT | https://github.com/mqttjs/MQTT.js |
| ws | MIT | https://github.com/websockets/ws |
| node-lox-ws-api | MIT | https://github.com/alladdin/node-lox-ws-api |

Alle drei Lizenzen erlauben uneingeschränkte Nutzung/Weitergabe (auch in
gebündelter Form), solange Copyright-Hinweis und Lizenztext erhalten bleiben
- das übernimmt diese Datei stellvertretend für alle drei.

## Hinweis zu transitiven Abhängigkeiten

Diese Tabelle deckt nur die drei direkten Abhängigkeiten aus `package.json`
ab. Für eine vollständige Aufstellung (inkl. transitiver Abhängigkeiten)
lokal nachvollziehbar mit:

```
cd bin && npm install && npm ls --all
```

oder für eine lizenzspezifische Aufstellung mit
[`license-checker`](https://github.com/apps/license-checker):

```
npx license-checker --summary
```

## Web-Frontend (`webfrontend/`)

Nutzt ausschliesslich LoxBerry-eigene Perl-Module (`LoxBerry::System`,
`LoxBerry::Web`) sowie Perl-Core-/Standard-Module - keine zusaetzlichen
Drittanbieter-Abhaengigkeiten im Backend. Das Frontend selbst ist reines
handgeschriebenes HTML/CSS/JS ohne externe Bibliotheken.
