# Eigene Daten und Dienste einrichten

Für das Ausprobieren reicht der [Demo-Start](../README.md). Diese Anleitung
beschreibt eine eigene Instanz mit dauerhaften Daten. Die Verbindungen werden
nicht aus der Demo übernommen. Sämtliche Zugangsdaten richtest du selbst ein.

## Konfiguration

Installiere Node.js ab Version 22 und beide Abhängigkeitssätze aus der README.
Kopiere `.env.example` im Hauptverzeichnis nach `.env.local` und trage Werte dort
lokal ein. Alternativ kannst du serverseitige Prozessvariablen setzen; diese
haben Vorrang. Die Backend-CLI lädt `.env.local` automatisch.

`npm start` bleibt immer die isolierte Demo. Für eigene Daten verwendest du
`npm run sales:api` und startest das Dashboard gesondert. Beende zuerst die Demo,
damit die lokalen Ports frei sind.

## Appwrite

Der Adapter verwendet die TablesDB-REST-Schnittstelle von Appwrite 2.0 mit
Transaktionen. Eine Appwrite-Instanz wird nicht mitinstalliert. Verwende deine
eigene Installation und richte darin ein Projekt mit der **Projekt-ID
`lead-research`** ein. Diese ID und die Datenbank-IDs `lead-research` sowie
`lead-research-demo` sind im Adapter bewusst festgelegt.

1. Setze `APPWRITE_TRANSPORT=rest`, deinen `APPWRITE_ENDPOINT` mit `/v1`,
   `APPWRITE_PROJECT_ID=lead-research` und `APPWRITE_DATABASE_ID=lead-research`.
2. Erzeuge in diesem Projekt einen eigenen Server-API-Schlüssel. Zur Einrichtung
   braucht er Datenbank-/Tabellen-/Spalten-/Index-Lese- und Schreibrechte sowie
   Zeilen- und Transaktionsrechte. Trage ihn als `APPWRITE_API_KEY` ein.
3. Prüfe, dass der Endpunkt deine eigene Instanz adressiert, und lege das Schema an:

   ```sh
   npm run db:init -- --execute
   ```

Der Befehl erstellt eine fehlende Datenbank und fehlende Tabellen aus
`infra/appwrite/`. Vorhandene Tabellen werden auf erwartete Spalten, Indizes und
geschlossene Berechtigungen geprüft. Er löscht oder migriert keine vorhandenen
Tabellen und importiert keine Leads. Bei einer Schemaabweichung stoppt er; bereits
erstellte Tabellen bleiben bestehen. Sind Spalten noch im Aufbau, warte bis
Appwrite sie als verfügbar meldet und führe den Befehl erneut aus.

Die anfängliche globale Versandsteuerung ist pausiert. Ersetze nach der
Einrichtung den Einrichtungsschlüssel durch einen Laufzeitschlüssel mit den
tatsächlich erforderlichen Tabellen-Lese-, Zeilen- und Transaktionsrechten.
Das Dashboard erhält niemals diesen Backend-Schlüssel.

Für REST ist HTTPS vorgeschrieben. Ein eigenes Loopback-/privates Containerziel
kann mit `APPWRITE_TRUSTED_HTTP=true` ausdrücklich über HTTP angesprochen werden.
Ein öffentlicher HTTP-Endpunkt wird abgewiesen.

Die Demodaten sind flüchtig und werden nicht automatisch übertragen. Die
[Architektur](architecture.md) beschreibt `buildStorageBundle` und den
Repository-Adapter für eigene Importe. Ein automatischer Importjob und eine
automatisch recherchierende KI sind nicht enthalten.

## Lokale API und Dashboard mit eigenen Daten

Im Hauptverzeichnis:

```sh
npm run sales:api
```

Die API bindet an `127.0.0.1:8787` und verlangt einen Bearer-Token. Ohne
`OUTREACH_API_TOKEN` erzeugt sie lokal einen zufälligen Schlüssel in
`.local/outreach/api-token.txt`. Die Datei bleibt durch `.gitignore` privat.

Kopiere `apps/dashboard/.env.example` nach `apps/dashboard/.env.local` und setze
für eigene Daten `DASHBOARD_TEST_MODE=false`. Starte in einem zweiten Terminal:

```sh
npm --prefix apps/dashboard run dev
```

Öffne `http://127.0.0.1:3210`. Das lokale Dashboard nutzt den privaten Token
serverseitig. Lokaler Modus hat keine Benutzeranmeldung und ist ausschließlich
für Loopback vorgesehen. Für einen Server gelten die
[Dashboard-Produktionsanleitung](../apps/dashboard/DEPLOYMENT.md) und die
nachfolgenden API-Einstellungen.

## Produktion

Die generischen Dockerfiles liegen in `infra/production/Dockerfile.api` und
`apps/dashboard/Dockerfile`. Eine eigene Appwrite-Installation, TLS, Reverse Proxy,
persistente Volumes, Backups und Domainkonfiguration musst du einrichten.

```sh
docker build -f infra/production/Dockerfile.api -t astra-sales-api .
docker build -t astra-sales-dashboard apps/dashboard
```

Für die API setze `NODE_ENV=production`, einen zufälligen
`OUTREACH_API_TOKEN` mit mindestens 32 Zeichen und für die Containerbindung
`OUTREACH_API_HOST=0.0.0.0`. `OUTREACH_API_ALLOWED_HOSTS` ist eine kommagetrennte
Liste der tatsächlich beim Backend eintreffenden Host-Header, etwa
`sales-api:8787,api.example.invalid`. Falls dein Proxy Origin-Header weiterleitet,
trage die erwarteten vollständigen HTTPS-Origins in
`OUTREACH_API_ALLOWED_ORIGINS` ein. Authentifizierung bleibt immer erforderlich.

Das API-Image läuft ohne Rootrechte. `/data/outreach-locks` benötigt ein
persistentes, für UID 1000 beschreibbares Volume; für einen gesonderten
Ereignisimport außerdem `/data/event-sync`. API und Ereignisimport müssen dieselbe
Sperrablage verwenden. Echte Zugangsdaten gehören in Laufzeit-Secrets, niemals
in das Image. Öffentlich exponiert werden nur die vorgesehenen TLS-Eingänge.

## Google Places

Setze deinen eigenen `GOOGLE_PLACES_API_KEY`. Aktiviere die Places API (New) und
die erforderliche Abrechnung im zugehörigen Cloud-Projekt. Die CLI verwendet
den Schlüssel ausschließlich serverseitig.

```sh
npm run places:check
npm run places:test
npm run places:search -- --country DE --city Berlin
```

`check` prüft nur die Konfiguration. `test` und `search` führen jeweils eine echte
Anfrage aus. Anbieteraufrufe können Kosten verursachen. Prüfe aktuelle
[Einrichtungshinweise](https://developers.google.com/maps/documentation/places/web-service/get-api-key),
[Feldmasken](https://developers.google.com/maps/documentation/places/web-service/text-search)
und [Places-Richtlinien](https://developers.google.com/maps/documentation/places/web-service/policies)
für deinen Anwendungsfall. Die CLI besucht keine Websites und schreibt keine
Places-Inhalte in die Datenbank.

## Brevo, Antworten und Versand

Für die eigene Anbindung setze `BREVO_API_KEY`, `OUTREACH_SENDER_EMAIL`,
`OUTREACH_SENDER_NAME` und `OUTREACH_REPLY_TO_EMAIL`. Der Absender muss in deinem
Brevo-Konto eingerichtet sein. `npm run outreach:check` zeigt nur den
Konfigurationsstatus und gibt keine Schlüssel aus.

`OUTREACH_SEND_ENABLED=false` ist der Standard. Ein tatsächlicher Versand braucht
zusätzlich eine aktive Kampagne/ein aktives Experiment, eine passende Bewertung,
verifizierte Kontaktberechtigung, Freigabe des exakten Inhalts, aufgehobene Pause,
eingehaltene Limits und einen ausdrücklichen `send --execute`- oder
`worker --execute`-Aufruf. Der Worker kann mit `--watch` wiederholt laufen und
verlangt zusätzlich einen eingerichteten Antwortabgleich. Die
öffentlichen Textbeispiele sind keine Versandfreigabe.

`npm run outreach -- help` listet die CLI-Befehle. Inhaltsschemas kannst du mit
`npm run outreach -- content:schemas` lesen. Die [fiktiven Vorlagen](../outreach/personalizations/)
zeigen das Format; ersetze ihre IDs und Belege für deine eigenen Datensätze.

Für einen manuell ausgelösten Brevo-Ereignisabgleich:

```sh
npm run outreach -- sync
```

Der optionale dauerhafte Prozess `node src/outreach/event-sync.mjs run` liest
Providerereignisse und versendet keine Nachrichten. Er setzt Linux,
`OUTREACH_LOCK_MODE=flock` und `OUTREACH_LOCK_DIR` voraus. Nutze dafür das
Backend-Containerimage mit den oben beschriebenen Volumes; ein direkter Start
unter Windows wird abgewiesen. Er lädt `.env.local`; im
Container übergibst du serverseitige Prozessvariablen. Ein Antwortabgleich benötigt zusätzlich `OUTREACH_IMAP_HOST`,
`OUTREACH_IMAP_USER`, `OUTREACH_IMAP_PASSWORD` und optional
`OUTREACH_IMAP_FOLDER`; `npm run outreach -- sync-replies` liest das Postfach.

## Optionaler Website-Abschluss

`POST /v1/integrations/website/quiz-completions` akzeptiert den versionierten
Vertrag aus `src/integrations/website-quiz.mjs` (`quiz_id: sales-roadmap`, interne
Quelle `sales-website`). Er verlangt einen separaten
`WEBSITE_QUIZ_BEARER_TOKEN`, der sich vom Operator-Token unterscheidet.
Übermittle ihn nur von deinem Website-Backend. Schema, Zuordnung,
Wiederholungsbehandlung und Testabgrenzung sind in `tests/website-quiz.test.mjs`
an fiktiven Daten beschrieben. Eine fertige Website, Outbox oder Buchungsintegration
ist nicht Teil dieses Repositories.
