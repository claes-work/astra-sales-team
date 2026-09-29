// Ausschließlich lokaler Node-Prozess / Backend. Nicht in Browser-Bundles importieren.
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const envFile = fileURLToPath(new URL('../.env.local', import.meta.url));
const endpoint = 'https://places.googleapis.com/v1/places:searchText';
const baseFields = 'places.id,places.displayName,places.formattedAddress,places.googleMapsUri,places.attributions';

export function loadKey() {
  // Eine bereits gesetzte Prozessvariable hat Vorrang; Datei wird dann nicht gelesen.
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    try { loadEnvFile(envFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Lokale .env.local konnte nicht geladen werden. Dateirechte und Format prüfen.');
    }
  }
  const key = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (!key) throw new Error('GOOGLE_PLACES_API_KEY fehlt. Wert in .env.local im Projektstammverzeichnis eintragen oder als Prozessvariable setzen.');
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('Schlüsselformat ungültig. Den vollständigen API-Schlüssel ohne Leerzeichen eintragen.');
  return key;
}

export async function searchPlaces({ key, request, smoke = false, websites = false, fetchImpl = fetch }) {
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) throw new Error('API-Schlüssel fehlt oder hat ein ungültiges Format.');
  if (!request || typeof request.textQuery !== 'string' || !request.textQuery.trim() || request.textQuery.length > 1000 || /[\x00-\x1f\x7f]/.test(request.textQuery)
    || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(request.languageCode) || !/^[A-Z]{2}$/.test(request.regionCode)) throw new Error('Ungültige Discovery-Anfrage: textQuery, languageCode und regionCode erforderlich.');
  const limit = smoke ? 1 : 5;
  const fields = smoke ? 'places.id' : baseFields + (websites ? ',places.websiteUri' : '');
  let response;
  try {
    // Exakt ein Aufruf: keine Retries, Redirects oder automatische Pagination.
    response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
      body: JSON.stringify({ textQuery: request.textQuery, languageCode: request.languageCode, regionCode: request.regionCode, pageSize: limit }),
    });
  } catch {
    throw new Error('Google Places nicht erreichbar oder Zeitlimit überschritten. Internet/Proxy prüfen; keine automatische Wiederholung.');
  }
  if (!response.ok) {
    // Keine fremden Fehlermeldungen, Header oder Request-Objekte ausgeben: könnten Secrets enthalten.
    const messages = {
      400: 'Anfrage abgelehnt. API-Schlüssel und Places API (New) prüfen.',
      401: 'Authentifizierung fehlgeschlagen. API-Schlüssel prüfen.',
      403: 'Zugriff verweigert. Places API (New), Abrechnung und API-/IP-Beschränkungen prüfen.',
      429: 'Kontingent oder Ratenlimit erreicht. Cloud-Kontingente prüfen.',
    };
    throw new Error(`Google Places HTTP ${response.status}: ${messages[response.status] ?? 'Dienstfehler; später manuell erneut versuchen.'}`);
  }
  try {
    const data = await response.json();
    const places = data.places ?? [];
    if (!Array.isArray(places) || places.some(p => !p || typeof p !== 'object' || Array.isArray(p) || typeof p.id !== 'string' || !p.id.trim())) throw new Error();
    return places.slice(0, limit);
  } catch { throw new Error('Google Places hat eine unlesbare Antwort geliefert.'); }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (!command || command === '--help') {
    console.log('Aufrufe: npm run places:check | npm run places:test | npm run places:search -- [--icp Datei.yaml] [--city Stadt] [--country Ländercode] [--query-index 0] [--websites]');
    return;
  }
  if (!['check', 'smoke', 'search'].includes(command)) throw new Error('Unbekannter Befehl. --help zeigt die Aufrufe.');
  let city;
  let country;
  let profilePath = process.env.ICP_PROFILE;
  let queryIndex = 0;
  let websites = false;
  for (let i = 0; i < options.length; i++) {
    if (command !== 'check' && ['--city', '--country', '--icp', '--query-index'].includes(options[i]) && options[i + 1] && !options[i + 1].startsWith('--')) {
      const option = options[i];
      const value = options[++i];
      if (option === '--city') city = value;
      if (option === '--country') country = value;
      if (option === '--icp') profilePath = value;
      if (option === '--query-index') queryIndex = /^\d+$/.test(value) ? Number(value) : NaN;
    }
    else if (command === 'search' && options[i] === '--websites') websites = true;
    else throw new Error('Ungültige Option. --help zeigt die Aufrufe.');
  }
  if (command === 'check') {
    loadKey();
    console.log('Schlüssel lokal geladen; keine Netzwerkanfrage. Gültigkeit bei Google noch nicht geprüft.');
    return;
  }
  const { loadProfile, buildDiscoveryRequest } = await import('./icp.mjs');
  const profile = await loadProfile(profilePath);
  const request = buildDiscoveryRequest(profile, { city, country, queryIndex });
  const key = loadKey();
  const places = await searchPlaces({ key, request, websites, smoke: command === 'smoke' });
  if (command === 'smoke') {
    console.log(`Verbindung erfolgreich: eine Anfrage, ${places.length} Treffer. Keine Inhalte gespeichert.`);
    return;
  }
  // Nur interaktive Anzeige; kein Export, Cache oder Log. Schlüssel auch bei unerwartetem Echo entfernen.
  const safe = value => String(value ?? '').replaceAll(key, '[entfernt]').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  console.log('Google Maps — Live-Ergebnisse (keine vollständige Firmenliste; keine Speicherung)');
  for (const p of places) {
    console.log(`\n${safe(p.displayName?.text)}\n${safe(p.formattedAddress)}\nPlace ID: ${safe(p.id)}\nGoogle Maps: ${safe(p.googleMapsUri)}`);
    if (websites) console.log(`Website: ${safe(p.websiteUri) || 'nicht hinterlegt'}`);
    for (const a of p.attributions ?? []) console.log(`Quelle: ${safe(a.provider)} ${safe(a.providerUri)}`);
  }
  if (!places.length) console.log('Keine Treffer für diese Anfrage.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
