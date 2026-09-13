import Ajv from 'ajv';
import { contentHash } from './profiles.mjs';
import { identity } from './experiment.mjs';
import { BERLIN, dayKey, instant } from '../operations/time.mjs';
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
export const rampSchema = { type: 'object', additionalProperties: false,
  required: ['schemaVersion','version','domain','timezone','target','startLimit','increment','minHealthySendDays','minDeliveredPerDay','observationHours','maxSyncAgeHours','idleResetDays','reductionFactor'],
  properties: { schemaVersion: { const: 1 }, version: { type: 'string', minLength: 1, maxLength: 40 }, domain: { type: 'string', pattern: '^[a-z0-9.-]+\\.[a-z]{2,}$', maxLength: 253 },
    timezone: { const: BERLIN }, target: integer(1,100), startLimit: integer(1,100), increment: integer(1,10), minHealthySendDays: integer(2,30),
    minDeliveredPerDay: integer(1,100), observationHours: integer(24,168), maxSyncAgeHours: integer(1,48), idleResetDays: integer(3,90), reductionFactor: { type: 'number', minimum: 0.1, maximum: 0.9 } } };
const validate = new Ajv({ allErrors: true }).compile(rampSchema);
export function validateRamp(p) {
  if (!validate(p) || p.startLimit > p.target || p.minDeliveredPerDay > p.startLimit) throw new Error('Ungültige Versandaufbau-Konfiguration.');
  return p;
}
const data = row => { try { return JSON.parse(row.details_json || '{}'); } catch { return {}; } };
const issues = new Set(['complaint','blocked','hard_bounce','invalid_email','soft_bounce','deferred','unsubscribed','provider_error']);
const critical = new Set(['complaint','blocked','hard_bounce','invalid_email']);
const hr = 3600000;
export function assessRamp({ policy, state, attempts, events, now }) {
  validateRamp(policy);
  const at = now.getTime(), closed = at - policy.observationHours * hr;
  const actual = attempts.filter(a => Date.parse(a.attempted_at) <= at);
  const observed = events.filter(e => actual.some(a=>a.message_id===e.message_id&&a.client_id===e.client_id&&Date.parse(a.attempted_at)<=Date.parse(e.occurred_at)) && Date.parse(e.occurred_at) <= at);
  const newIssues = observed.filter(e => issues.has(e.event_type) && !state.acknowledged.includes(e.$id));
  const last = Math.max(...actual.map(a => Date.parse(a.attempted_at)));
  const idle = Number.isFinite(last) && at - last >= policy.idleResetDays * 86400000;
  const base = Math.min(state.limit, policy.target, idle ? policy.startLimit : 100);
  const unknown = actual.filter(a => Date.parse(a.attempted_at) <= closed && (!['accepted','rejected'].includes(a.status)
    || (a.status === 'accepted' && !observed.some(e => e.message_id === a.message_id && ['provider_sent','delivered',...issues].includes(e.event_type)))));
  const stale = actual.filter(a => {
    const attempted=Date.parse(a.attempted_at),synced=Date.parse(data(a).lastSyncAt);
    if(a.status==='rejected'||attempted>closed)return false;
    // Once the full observation window was synced, old completed messages do not
    // require a forever-growing daily full-history poll. Newly arriving issues still block.
    const recent=at-attempted<=(policy.observationHours+policy.maxSyncAgeHours)*hr;
    return !Number.isFinite(synced)||synced>at||synced<attempted+policy.observationHours*hr||(recent&&at-synced>policy.maxSyncAgeHours*hr);
  });
  const byDay = Map.groupBy(actual.filter(a => Date.parse(a.attempted_at) >= Date.parse(state.epochStartedAt)), a => dayKey(a.attempted_at));
  const healthyDays = [];
  for (const [day, rows] of byDay) {
    const lastAttempt = Math.max(...rows.map(a => Date.parse(a.attempted_at)));
    const ready = lastAttempt <= closed && rows.length >= policy.minDeliveredPerDay && rows.every(a => {
      const es = observed.filter(e => e.message_id === a.message_id);
      const synced = Date.parse(data(a).lastSyncAt);
      return a.status === 'accepted' && es.some(e => e.event_type === 'delivered') && !es.some(e => issues.has(e.event_type))
        && synced >= lastAttempt + policy.observationHours * hr && synced<=at && at - synced <= policy.maxSyncAgeHours * hr;
    });
    if (ready && !state.usedDays.includes(day)) healthyDays.push(day);
  }
  healthyDays.sort();
  const reason = state.paused ? 'Versandaufbau pausiert' : newIssues.length ? 'Neue Problemereignisse prüfen'
    : unknown.length ? 'Ältere Versandversuche ohne belastbaren Ausgang' : stale.length ? 'Anbieter-Abgleich zu alt oder unbekannt' : null;
  const reduced = !state.paused && newIssues.some(e => !critical.has(e.event_type) && e.event_type !== 'unsubscribed');
  const safeLimit = reduced ? Math.max(1, Math.floor(base * policy.reductionFactor)) : base;
  const eligible = !reason && !idle && healthyDays.length >= policy.minHealthySendDays && base < policy.target;
  return { policyVersion: policy.version, scope: 'global_all_campaigns_clients_senders', timezone: BERLIN, target: policy.target,
    currentLimit: base, safeLimit, blocked: Boolean(reason), reason, idleReset: idle,
    newIssueIds: newIssues.map(e => e.$id), criticalIssueIds: newIssues.filter(e => critical.has(e.event_type)).map(e => e.$id),
    unknownAttempts: unknown.length, staleSyncAttempts: stale.length, healthyDays,
    eligibleToRequestIncrease: eligible, proposedLimit: eligible ? Math.min(policy.target, base + policy.increment) : safeLimit,
    domainReputation: null, accountIpType: null,
    todayReservations: actual.filter(a => dayKey(a.attempted_at) === dayKey(now)).length,
    rolling24hReservations: actual.filter(a => at - Date.parse(a.attempted_at) < 86400000).length,
    note: 'Keine automatische Erhöhung. Frische begründete Betreiberprüfung zusätzlich erforderlich; externe Reputation nicht automatisch gemessen.' };
}

export class RampControl {
  constructor(service) { this.s = service; this.repo = service.repo; }
  async row() { return this.repo.get('outreach_ramp', 'default'); }
  async snapshot() {
    const row = await this.row();
    if (!row) return { configured: false, blocked: true, reason: 'Versandaufbau nicht eingerichtet' };
    const policy = JSON.parse(row.policy_json), state = JSON.parse(row.state_json);
    return { configured: true, revision: row.revision, policy, state,
      ...assessRamp({ policy, state, attempts: await this.repo.list('outreach_attempts'), events: await this.repo.list('outreach_events'), now: this.s.now() }) };
  }
  async write(row, policy, state, action, details) {
    const now = this.s.now().toISOString();
    const revision = contentHash({ previous: row?.revision ?? null, policy, state, action, details, now });
    const value = { policy_json: JSON.stringify(policy), state_json: JSON.stringify(state), revision, updated_at: now };
    await this.repo.transaction([
      { action: row ? 'update' : 'create', table: 'outreach_ramp', id: 'default', data: value },
      { action: 'create', table: 'outreach_ramp_events', id: identity('rmp', revision), data: { revision, action, occurred_at: now, details_json: JSON.stringify({ policy, state, ...details }) } },
    ]);
    return { revision, policy, state };
  }
  async configure({ policy, expectedRevision, by, reason }) {
    return this.s.lock(async () => {
      validateRamp(policy); if (!by?.trim() || !reason?.trim()) throw new Error('Konfiguration braucht Bearbeiter und Begründung.');
      const row = await this.row();
      if (row && expectedRevision !== row.revision) throw new Error('Versandaufbau inzwischen geändert.');
      if (row && JSON.parse(row.policy_json).version === policy.version) throw new Error('Neue Regelversion erforderlich.');
      const previous = row ? JSON.parse(row.state_json) : null;
      const state = { limit: Math.min(previous?.limit ?? policy.startLimit, policy.startLimit), paused: previous?.paused ?? false,
        epochStartedAt: this.s.now().toISOString(), acknowledged: previous?.acknowledged ?? [], usedDays: previous?.usedDays ?? [] };
      return this.write(row, policy, state, 'configure', { by, reason });
    });
  }
  async decide({ expectedRevision, action, by, evidence, observedAt, domainStatus }) {
    return this.s.lock(async () => {
      const row = await this.row(); const view = await this.snapshot();
      if (!row || expectedRevision !== row.revision) throw new Error('Aktuelle Revision erforderlich.');
      if (!['increase','resolve'].includes(action) || !by?.trim() || !evidence?.trim()) throw new Error('Entscheidung braucht Aktion, Prüfer und konkreten Prüfbeleg.');
      const at = Date.parse(instant(observedAt));
      if (at > this.s.now().getTime() || this.s.now() - at > view.policy.maxSyncAgeHours * hr || domainStatus !== 'acceptable') throw new Error('Aktuelle positive Prüfung der Absender-/Domainlage erforderlich; unbekannt reicht nicht.');
      const state = structuredClone(view.state);
      if (action === 'increase') {
        if (!view.eligibleToRequestIncrease) throw new Error('Keine belegte Grundlage für eine Erhöhung.');
        state.limit = view.proposedLimit;
        state.usedDays.push(...view.healthyDays.slice(0, view.policy.minHealthySendDays));
      } else {
        if (view.unknownAttempts || view.staleSyncAttempts) throw new Error('Zuerst unbekannte Ausgänge und veralteten Abgleich klären.');
        state.limit = Math.min(view.safeLimit, view.policy.startLimit);
        state.acknowledged = [...new Set([...state.acknowledged, ...view.newIssueIds])];
        state.paused = false;
      }
      state.epochStartedAt = this.s.now().toISOString();
      return this.write(row, view.policy, state, action, { by, evidence, observedAt, domainStatus, assessment: view });
    });
  }
  async guard(sender) {
    // Called under the same lock as the durable send reservation.
    let view = await this.snapshot();
    if (!view.configured) {
      // Compatibility for old isolated unit/demo fixtures; never allows a real transport.
      if (this.s.provider?.name === 'demo' && this.repo.database === 'lead-research-demo') return null;
      throw new Error(view.reason);
    }
    if (sender.split('@')[1].toLowerCase() !== view.policy.domain) throw new Error('Absenderdomain passt nicht zum eingerichteten Versandaufbau.');
    if (view.idleReset && (view.state.limit>view.policy.startLimit || !view.state.idleResetAt || Date.parse(view.state.idleResetAt)<Date.parse(view.state.epochStartedAt))) {
      const at=this.s.now().toISOString();
      await this.write(await this.row(),view.policy,{...view.state,limit:Math.min(view.state.limit,view.policy.startLimit),epochStartedAt:at,idleResetAt:at},'idle_reset',{reason:'Neustart nach längerer Versandpause; frühere hohe Grenze wird nicht nach der ersten Mail wiederhergestellt.'});
      view=await this.snapshot();
    }
    if (view.newIssueIds.length && !view.state.paused) {
      await this.write(await this.row(), view.policy, { ...view.state, limit: view.safeLimit, paused: true }, 'protect', { assessment: view });
    }
    if (view.blocked) throw new Error(view.reason);
    if (Math.max(view.todayReservations, view.rolling24hReservations) >= view.safeLimit) throw new Error('Versandaufbau-Limit erreicht (Berliner Tag und rollierende 24 Stunden).');
    return { revision: view.revision, limit: view.safeLimit, domain: view.policy.domain };
  }
}
