# Dashboard ausführen

Das Dashboard benötigt Node.js ab Version 22. Die lokale Demo wird von der
Repositorywurzel aus gestartet; siehe [README](../../README.md). Dabei zeigt die
Oberfläche fiktive Daten und braucht weder Appwrite noch ein Benutzerkonto.

Für die separate Frontendentwicklung in `apps/dashboard`:

```sh
npm ci
npm run dev
```

Die Demo-API muss bereits auf `127.0.0.1:8787` laufen. Das Dashboard öffnet auf
`http://127.0.0.1:3210`. Der API-Token wird serverseitig aus
`../../.local/outreach/api-token.txt` gelesen; der Demostart erzeugt ihn lokal.
Alternativ kann `SALES_API_TOKEN_FILE` auf eine eigene Datei zeigen.
Die Befehle `dev` und `start` setzen `DASHBOARD_MODE=local` und binden an
`127.0.0.1`. `PORT` und `SALES_API_PORT` lassen sich vor dem Start als
Prozessumgebungsvariablen setzen. Ein gesetzter Produktionsmodus wird von diesen
beiden Befehlen abgewiesen. Für `npm start` muss vorher `npm run build` laufen.

```sh
npm test
npm run build
npm run typecheck
```

Die Tests arbeiten mit fiktiven Eingaben. Der Build erzeugt außerdem die
Next.js-Routentypen für den anschließenden TypeScript-Check.

## Eigene Bereitstellung

Die Containerfassung verwendet den Next.js-Standalone-Server und erwartet eine
separat eingerichtete Sales-API sowie Appwrite für die Anmeldung. Die lokale
Demo ist kein dauerhafter Datenspeicher. Der Docker-Build richtet weder Appwrite
noch die Sales-Datenbank ein.

Aus `apps/dashboard`:

```sh
docker build -t astra-sales-dashboard .
```

Das Image startet mit `node server.js`, hört intern auf Port 3000 und läuft als
Benutzer `node`. Eine eigene Bereitstellung benötigt einen HTTPS-Reverse-Proxy,
der den öffentlichen Host erhält. Die API und Appwrite müssen vom Container
aus erreichbar sein. Der Proxy muss `X-Forwarded-Host` (falls gesetzt) auf den
öffentlichen Host und `X-Forwarded-Proto` auf `https` setzen.

| Variable | Bedeutung |
| --- | --- |
| `DASHBOARD_MODE` | Für diese Bereitstellung `production`. |
| `DASHBOARD_ORIGIN` | Öffentliche HTTPS-Origin ohne Pfad, etwa `https://sales.example.invalid`. |
| `SALES_API_URL` | Basis-URL der eigenen Sales-API ohne `/v1`-Suffix, etwa `http://sales-api:8787`. |
| `SALES_API_TOKEN_FILE` | Lesbare Secretdatei mit dem Bearer-Token der Sales-API. |
| `APPWRITE_ENDPOINT` | Appwrite-API-Endpunkt einschließlich `/v1`. |
| `APPWRITE_PROJECT_ID` | `lead-research`, passend zum eigenen Backend-Projekt. |
| `APPWRITE_SSR_KEY_FILE` | Lesbare Secretdatei mit einem Appwrite-Schlüssel mit `sessions.write` für die serverseitige Anmeldung. |
| `DASHBOARD_ALLOWED_USER_IDS` | Kommagetrennte IDs aktiver Appwrite-Nutzer mit Dashboardzugriff. |
| `DASHBOARD_TEST_MODE` | Nur für fiktive Daten `true`; zeigt das Demobanner. |
| `PORT` | Interner HTTP-Port; im Image `3000`. |
| `HOSTNAME` | Bindeadresse des Standalone-Servers; im Image `0.0.0.0`. |
| `NEXT_TELEMETRY_DISABLED` | Im Image `1`. |

Statt der beiden Secretdateien werden auch `SALES_API_TOKEN` und
`APPWRITE_SSR_KEY` unterstützt. Eine gesetzte `_FILE`-Variable hat Vorrang.
Secrets gehören in die Laufzeitkonfiguration, nicht in Image, Git oder
`NEXT_PUBLIC_*`-Variablen. [.env.example](.env.example) enthält ausschließlich
Platzhalter und lokale Vorgaben.

Appwrite-Nutzer müssen im angegebenen Projekt angelegt, aktiv und in der
Allowlist enthalten sein. Die Anmeldung verwendet E-Mail und Passwort; die
Appwrite-Session wird bei Datenzugriffen serverseitig geprüft. Sessioncookies
sind im Produktionsmodus `HttpOnly`, `Secure` und `SameSite=Lax`.

`GET /api/health` zeigt nur den Dashboardstatus. Der Endpunkt prüft keine
Backendverbindung. Nach der eigenen Einrichtung deshalb Anmeldung, Leadabruf,
Rückmeldung, Abmeldung und verweigerten anonymen Zugriff gesondert prüfen.

Die UI bietet keinen Mailversand. Sie erlaubt das Lesen der Dashboarddaten und
Entwürfe sowie validierte manuelle Rückmeldungen und Kontaktsperren.
