'use client';
export default function Error({ reset }: { reset: () => void }) { return <div className="error-box" role="alert"><h1>Die Ansicht konnte nicht geladen werden</h1><p>Bitte die Verbindung zur lokalen API prüfen und erneut versuchen.</p><button onClick={reset}>Erneut versuchen</button></div>; }
