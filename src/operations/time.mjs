export const BERLIN = 'Europe/Berlin';
export const dayKey = value => new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export function instant(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Zeitpunkt mit Zeitzone erforderlich.');
  return new Date(value).toISOString();
}
export function dateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Gültiger Berichtstag erforderlich.');
  return value;
}
export function overlapMs(start, end, day) {
  // UTC hourly slices also handle the 23/25-hour Berlin DST days without a fixed offset.
  let total = 0;
  for (let at = Date.parse(start), stop = Date.parse(end); at < stop;) {
    const next = Math.min(stop, Math.floor(at / 3600000) * 3600000 + 3600000);
    if (dayKey(at) === day) total += next - at;
    at = next;
  }
  return total;
}
export function intervalDays(start,end) {
  const days=new Set();const stop=Date.parse(end);
  if(!Number.isFinite(stop)||stop<Date.parse(start))return [];
  for(let at=Date.parse(start);at<stop;at+=12*3600000)days.add(dayKey(at));
  days.add(dayKey(stop));return [...days];
}
