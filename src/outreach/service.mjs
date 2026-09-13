import { randomBytes } from 'node:crypto';
import { assignVariant, email, hash, identity, render, validateExperiment } from './experiment.mjs';
import { withOutreachLock } from './lock.mjs';
import { DEMO_DB } from './appwrite.mjs';
import { ContentLibrary } from './content.mjs';
import { contentHash as profileHash } from './profiles.mjs';
import { buildReport } from './report.mjs';
import { RampControl } from './ramp.mjs';
import { dayKey } from '../operations/time.mjs';

const requireRow = (row, label) => { if (!row) throw new Error(`${label} fehlt.`); return row; };
const owner = (row, client) => { if (row.client_id !== client) throw new Error('Auftraggeber passen nicht zusammen.'); return row; };
const utc = value => {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Zeitpunkt mit Zeitzone erforderlich.');
  return new Date(value).toISOString();
};
const canonicalKind = kind => {
  const key = String(kind).replace(/[_\s-]/g, '').toLowerCase();
  return ({ request: 'provider_accepted', sent: 'provider_sent', delivered: 'delivered', hardbounce: 'hard_bounce', hardbounces: 'hard_bounce',
    softbounce: 'soft_bounce', softbounces: 'soft_bounce', invalidemail: 'invalid_email', blocked: 'blocked', spam: 'complaint',
    unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed', opened: 'opened', opening: 'opened', uniqueopened: 'opened',
    uniqueopening: 'opened', proxyopen: 'proxy_open', uniqueproxyopen: 'proxy_open', clicks: 'clicked', clicked: 'clicked',
    error: 'provider_error', deferred: 'deferred' })[key] ?? 'provider_other';
};
const blocking = new Set(['hard_bounce', 'invalid_email', 'blocked', 'complaint', 'unsubscribed']);
const replies = new Set(['reply_received', 'reply_positive', 'reply_negative', 'reply_question', 'auto_reply']);
export const outcomeTypes = new Set([...replies, 'unsubscribed', 'quiz_completed', 'meeting_booked', 'meeting_qualified', 'meeting_disqualified', 'meeting_held', 'meeting_cancelled', 'workshop_won', 'review_note']);

export function dayContext(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekend: ['Sat', 'Sun'].includes(parts.weekday) };
}

export class OutreachService extends ContentLibrary {
  constructor({ repo, provider, env = {}, now = () => new Date(), lock = withOutreachLock }) {
    super();
    this.repo = repo; this.provider = provider; this.env = env; this.now = now; this.lock = lock;
    this.ramp = new RampControl(this);
  }
  async createExperiment(input) { return this.lock(() => this._createExperiment(input)); }
  async _createExperiment({ clientId, campaignId, definition }) {
    validateExperiment(definition);
    const campaign = owner(requireRow(await this.repo.get('campaigns', campaignId), 'Kampagne'), clientId);
    const sender = { email: email(this.env.OUTREACH_SENDER_EMAIL), name: this.env.OUTREACH_SENDER_NAME?.trim() };
    const replyTo = email(this.env.OUTREACH_REPLY_TO_EMAIL);
    if (!sender.name || sender.name.length > 255 || /[\r\n\x00-\x1f]/.test(sender.name)) throw new Error('Absendername fehlt oder ist ungültig.');
    let contentVersion;
    if (definition.schemaVersion === 2) {
      contentVersion = await this.resolveVersion(clientId, 'experiment', definition);
      if (profileHash(definition) !== contentVersion.contentHash) throw new Error('Experimentdefinition weicht von ihrer eingefrorenen Version ab.');
    }
    const contentHash = hash({ definition, sender, replyTo, icpVersionId: campaign.active_icp_version_id, ...(contentVersion ? { contentVersion } : {}) });
    const id = identity('exp', clientId, campaignId, contentHash);
    const existing = await this.repo.get('outreach_experiments', id);
    if (existing) return existing;
    return this.repo.create('outreach_experiments', id, { client_id: clientId, campaign_id: campaignId, name: definition.name,
      definition_hash: contentHash, status: 'draft', definition_json: JSON.stringify({ definition, sender, replyTo,
        icpVersionId: campaign.active_icp_version_id, ...(contentVersion ? { contentVersion } : {}), seed: randomBytes(32).toString('hex'), createdAt: this.now().toISOString() }) });
  }
  async enroll(input) { return this.lock(() => this._enroll(input)); }
  async _enroll({ experimentId, assessmentId, contactId, personalizationVersionId, variantSelection }) {
    const experiment = requireRow(await this.repo.get('outreach_experiments', experimentId), 'Experiment');
    if (!['draft', 'active'].includes(experiment.status)) throw new Error('Experiment nimmt keine neuen Firmen auf.');
    const assessment = owner(requireRow(await this.repo.get('assessments', assessmentId), 'Bewertung'), experiment.client_id);
    const contact = owner(requireRow(await this.repo.get('contacts', contactId), 'Kontakt'), experiment.client_id);
    const company = owner(requireRow(await this.repo.get('companies', assessment.company_id), 'Firma'), experiment.client_id);
    const run = owner(requireRow(await this.repo.get('research_runs', assessment.run_id), 'Recherche'), experiment.client_id);
    const snapshot = JSON.parse(experiment.definition_json);
    if (variantSelection && (snapshot.definition.schemaVersion !== 2 || !snapshot.definition.variants.some(v => v.id === variantSelection.id)
      || !variantSelection.by?.trim() || !variantSelection.reason?.trim() || Object.keys(variantSelection).some(k => !['id','by','reason'].includes(k))))
      throw new Error('Redaktionelle Betreffauswahl braucht einen vorhandenen Kandidaten, Bearbeiter und Begründung.');
    if (assessment.status !== 'qualified' || !assessment.eligible_for_enrichment || contact.company_id !== company.$id
      || run.campaign_id !== experiment.campaign_id || assessment.icp_version_id !== snapshot.icpVersionId)
      throw new Error('Lead, Recherche und festgehaltene Profilversion passen nicht zum Experiment.');
    const id = identity('enr', experimentId, company.$id);
    const existing = await this.repo.get('outreach_enrollments', id);
    if (existing) {
      if (variantSelection && (existing.variant_id !== variantSelection.id || !JSON.parse(existing.snapshot_json).variantSelection)) throw new Error('Firma bereits mit einer anderen Betreffauswahl zugeordnet.');
      if (existing.contact_id !== contactId || existing.assessment_id !== assessmentId) throw new Error('Firma bereits mit einem anderen Kontakt/Bewertungsstand zugeordnet.');
      if (snapshot.definition.schemaVersion === 2 && JSON.parse(existing.snapshot_json).personalization?.id !== personalizationVersionId) throw new Error('Firma bereits mit einer anderen Mailversion zugeordnet. Neues Experiment für neue Fassung verwenden.');
      return existing;
    }
    if (company.do_not_contact || contact.do_not_contact) throw new Error('Firma oder Kontakt gesperrt.');
    let personalization;
    if (snapshot.definition.schemaVersion === 2) {
      if (!personalizationVersionId) throw new Error('Geprüfte individuelle Mailversion fehlt.');
      personalization = await this.getContent({ id: personalizationVersionId, version: true });
      if (personalization.kind !== 'personalization' || personalization.clientId !== experiment.client_id
        || personalization.definition.assessmentId !== assessmentId || personalization.definition.contactId !== contactId
        || personalization.dependencies.experiment.id !== snapshot.contentVersion.id) throw new Error('Mailversion, Kontakt und Experiment passen nicht zusammen.');
      if (personalization.definition.review.status !== 'approved') throw new Error('Redaktionelles Review fehlt. Zuerst Entwurfsvorschau prüfen.');
      // Revalidate current source age, qualification and reviewed rules before freezing this enrollment.
      const rechecked = await this.preparePersonalization({ clientId: experiment.client_id, definition: personalization.definition, experiment: snapshot.contentVersion });
      if (profileHash(rechecked.evidence) !== profileHash(personalization.dependencies.evidence)) throw new Error('Belegstand hat sich seit dem Review verändert. Neue geprüfte Mailversion erforderlich.');
      if (this.now().getTime() >= Date.parse(snapshot.definition.enrollmentWindow.endsAt)) throw new Error('Testfenster beendet. Neue Experimentversion planen.');
    } else if (personalizationVersionId) throw new Error('Individuelle Mailversion braucht Experiment v2.');
    const variant = variantSelection?.id ?? assignVariant(snapshot.definition, snapshot.seed, experiment.client_id, company.$id);
    const text = render(snapshot.definition, variant, { company: company.name, senderName: snapshot.sender.name, personalization: personalization?.definition });
    const target = email(contact.email);
    const messageId = identity('msg', id, 'first');
    const contentHash = hash({ ...text, to: target, sender: snapshot.sender, replyTo: snapshot.replyTo, ...(personalization ? { personalization } : {}) });
    const data = { client_id: experiment.client_id, experiment_id: experimentId, company_id: company.$id, contact_id: contactId,
      assessment_id: assessmentId, message_id: messageId, variant_id: variant, content_hash: contentHash,
      snapshot_json: JSON.stringify({ sender: snapshot.sender, replyTo: snapshot.replyTo, companyName: company.name,
        ...(variantSelection ? { variantSelection: { ...variantSelection, method: 'editorial_not_randomized' } } : {}),
        definitionHash: experiment.definition_hash, ...(personalization ? { personalization } : {}), enrolledAt: this.now().toISOString(), sequenceStep: 'first' }) };
    await this.repo.transaction([
      { action: 'create', table: 'outreach_enrollments', id, data },
      { action: 'create', table: 'outreach_messages', id: messageId, data: { client_id: experiment.client_id, campaign_id: experiment.campaign_id,
        company_id: company.$id, contact_id: contactId, assessment_id: assessmentId, channel: 'email', sequence_step: 'first',
        dedupe_key: hash([experimentId, company.$id, 'first']), target_address: target, status: 'draft', ...text } },
    ]);
    return { $id: id, ...data };
  }
  async permission(input) { return this.lock(() => this._permission(input)); }
  async _permission({ clientId, contactId, status, basis, providerAllowed, evidence, checkedBy }) {
    owner(requireRow(await this.repo.get('contacts', contactId), 'Kontakt'), clientId);
    if (!['unknown', 'verified', 'revoked'].includes(status) || !['unknown', 'consent', 'existing_customer', 'internal_test'].includes(basis)
      || typeof providerAllowed !== 'boolean' || typeof evidence !== 'string' || !evidence.trim() || !checkedBy?.trim()) throw new Error('Kontaktfreigabe braucht Status, Grundlage, Beleg und Prüfer.');
    if (status === 'verified' && (basis === 'unknown' || !providerAllowed)) throw new Error('Keine bestätigte Versand-/Anbietergrundlage.');
    if (basis === 'internal_test' && this.repo.database !== DEMO_DB) throw new Error('Testfreigaben nur in der getrennten Demo-Datenbank.');
    const id = identity('per', clientId, contactId);
    const data = { client_id: clientId, contact_id: contactId, status, basis, provider_allowed: providerAllowed,
      evidence, checked_by: checkedBy, checked_at: this.now().toISOString() };
    return await this.repo.get('outreach_permissions', id) ? this.repo.update('outreach_permissions', id, data) : this.repo.create('outreach_permissions', id, data);
  }
  async context(messageId) {
    const message = requireRow(await this.repo.get('outreach_messages', messageId), 'Nachricht');
    const enrollments = await this.repo.list('outreach_enrollments');
    const enrollment = requireRow(enrollments.find(e => e.message_id === messageId), 'Experimentzuordnung');
    const experiment = owner(requireRow(await this.repo.get('outreach_experiments', enrollment.experiment_id), 'Experiment'), message.client_id);
    const company = owner(requireRow(await this.repo.get('companies', message.company_id), 'Firma'), message.client_id);
    const contact = owner(requireRow(await this.repo.get('contacts', message.contact_id), 'Kontakt'), message.client_id);
    const campaign = owner(requireRow(await this.repo.get('campaigns', message.campaign_id), 'Kampagne'), message.client_id);
    const assessment = owner(requireRow(await this.repo.get('assessments', message.assessment_id), 'Bewertung'), message.client_id);
    const permission = await this.repo.get('outreach_permissions', identity('per', message.client_id, message.contact_id));
    const snapshot = JSON.parse(enrollment.snapshot_json);
    if (enrollment.client_id !== message.client_id || enrollment.company_id !== message.company_id || enrollment.contact_id !== message.contact_id
      || enrollment.assessment_id !== message.assessment_id || contact.company_id !== company.$id || experiment.campaign_id !== campaign.$id)
      throw new Error('Nachrichtenreferenzen passen nicht zusammen.');
    const experimentSnapshot = JSON.parse(experiment.definition_json);
    if (experimentSnapshot.definition.schemaVersion === 2) {
      const { definition, sender, replyTo, icpVersionId, contentVersion } = experimentSnapshot;
      if (hash({ definition, sender, replyTo, icpVersionId, contentVersion }) !== experiment.definition_hash || snapshot.definitionHash !== experiment.definition_hash
        || !snapshot.personalization) throw new Error('Eingefrorene Strategie-/Experimentreferenz wurde verändert.');
    }
    if (hash({ subject: message.subject, body: message.body, to: message.target_address, sender: snapshot.sender, replyTo: snapshot.replyTo,
      ...(snapshot.personalization ? { personalization: snapshot.personalization } : {}) }) !== enrollment.content_hash)
      throw new Error('Nachricht wurde nach Zuordnung verändert. Neue geprüfte Fassung erforderlich.');
    return { message, enrollment, experiment, company, contact, campaign, permission, snapshot, assessment };
  }
  async eligible(context) {
    const { message, contact, company, campaign, permission, assessment, experiment } = context;
    if (campaign.status !== 'active') throw new Error('Kampagne ist nicht aktiv.');
    const frozen = JSON.parse(experiment.definition_json);
    if (frozen.definition.schemaVersion === 2) {
      if (frozen.contentVersion.dependencies.strategy.definition.readiness !== 'ready') throw new Error('Strategie ist eine Arbeitsfassung und noch nicht versandbereit.');
      const maxAge = frozen.contentVersion.dependencies.strategy.definition.research.maxEvidenceAgeDays * 86400000;
      if (context.snapshot.personalization.dependencies.evidence.some(e => this.now() - new Date(e.observedAt) > maxAge)) throw new Error('Belege inzwischen zu alt. Neue Recherche und Fassung erforderlich.');
    }
    if (assessment.status !== 'qualified' || !assessment.eligible_for_enrichment || assessment.company_id !== company.$id
      || assessment.icp_version_id !== JSON.parse(experiment.definition_json).icpVersionId)
      throw new Error('Die zugrunde liegende Bewertung ist nicht mehr qualifiziert oder passt nicht zur eingefrorenen Profilversion.');
    if (contact.do_not_contact || company.do_not_contact) throw new Error('Kontaktsperre aktiv.');
    if (email(contact.email) !== message.target_address) throw new Error('Kontaktadresse hat sich geändert. Entwurf neu prüfen.');
    if (!permission || permission.status !== 'verified' || !permission.provider_allowed || !permission.evidence?.trim()) throw new Error('Bestätigte Kontakt- und Anbieterfreigabe fehlt.');
    const suppressions = await this.repo.list('outreach_suppressions');
    if (suppressions.some(s => s.client_id === message.client_id && s.email === message.target_address)) throw new Error('Adresse steht auf der Sperrliste.');
    const allMessages = await this.repo.list('outreach_messages');
    if (allMessages.some(m => m.$id !== message.$id && m.client_id === message.client_id && m.company_id === message.company_id
      && m.channel === 'email' && m.sequence_step === 'first' && ['approved', 'sending', 'sent'].includes(m.status)))
      throw new Error('Für diese Firma ist bereits eine Erstansprache freigegeben oder versendet. Keine überlappenden Erstkontakt-Experimente.');
    const sameFirm = new Set(allMessages.filter(m => m.client_id === message.client_id && m.company_id === message.company_id).map(m => m.$id));
    const events = await this.repo.list('outreach_events');
    if (events.some(e => sameFirm.has(e.message_id) && (replies.has(e.event_type) || ['meeting_booked', 'unsubscribed'].includes(e.event_type))))
      throw new Error('Antwort oder Termin vorhanden; weitere Ansprache braucht manuelle Prüfung.');
  }
  async preview(messageId) {
    const context = await this.context(messageId);
    let reason = null;
    try { await this.eligible(context); } catch (error) { reason = error.message; }
    return { messageId, variant: context.enrollment.variant_id, sender: context.snapshot.sender, replyTo: context.snapshot.replyTo,
      to: context.message.target_address, subject: context.message.subject, body: context.message.body,
      contentHash: context.enrollment.content_hash, status: context.message.status, permissionReady: reason === null, blockReason: reason,
      ...(context.snapshot.personalization ? { personalization: context.snapshot.personalization,
        experimentVersion: JSON.parse(context.experiment.definition_json).contentVersion,
        candidates: JSON.parse(context.experiment.definition_json).definition.variants.map(v => ({ variant: v.id, method: v.subjectMethod,
          ...render(JSON.parse(context.experiment.definition_json).definition, v.id, { personalization: context.snapshot.personalization.definition }) })),
        semanticsAutomaticallyVerified: false } : {}) };
  }
  async approve({ messageId, contentHash, approvedBy }) {
    return this.lock(async () => {
      const context = await this.context(messageId);
      if (context.message.status !== 'draft' || !approvedBy?.trim() || contentHash !== context.enrollment.content_hash) throw new Error('Freigabe erfordert den geprüften Entwurf und seine Inhaltsprüfsumme.');
      await this.eligible(context);
      const at = this.now().toISOString();
      const event = this.eventRow(context.message, 'message_approved', at, { approvedBy, contentHash, permission: context.permission }, contentHash);
      await this.repo.transaction([
        { action: 'update', table: 'outreach_messages', id: messageId, data: { status: 'approved', approved_by: approvedBy, approved_at: at } },
        { action: 'create', table: 'outreach_events', ...event },
      ]);
      return { messageId, status: 'approved' };
    });
  }
  async reviseUnsent({ messageId, personalizationVersionId, expectedHash, revisedBy, reason }) {
    return this.lock(async () => {
      const current = await this.context(messageId);
      if (!['draft', 'approved'].includes(current.message.status) || (await this.repo.list('outreach_attempts')).some(a => a.message_id === messageId))
        throw new Error('Nachricht hat bereits einen Versandversuch oder ist nicht mehr bearbeitbar.');
      if (current.enrollment.content_hash !== expectedHash || !revisedBy?.trim() || !reason?.trim()) throw new Error('Aktueller Inhaltsstand, Bearbeiter und Änderungsgrund erforderlich.');
      const frozen = JSON.parse(current.experiment.definition_json);
      const personalization = await this.getContent({ id: personalizationVersionId, version: true });
      if (frozen.definition.schemaVersion !== 2 || personalization.kind !== 'personalization' || personalization.clientId !== current.message.client_id
        || personalization.definition.contactId !== current.message.contact_id || personalization.definition.assessmentId !== current.message.assessment_id
        || personalization.dependencies.experiment.id !== frozen.contentVersion.id || personalization.definition.review.status !== 'approved')
        throw new Error('Neue geprüfte Version passt nicht zur vorhandenen Nachricht.');
      const rechecked = await this.preparePersonalization({ clientId: current.message.client_id, definition: personalization.definition, experiment: frozen.contentVersion });
      if (profileHash(rechecked.evidence) !== profileHash(personalization.dependencies.evidence)) throw new Error('Belegstand verändert; neue Prüfung erforderlich.');
      const text = render(frozen.definition, current.enrollment.variant_id, { personalization: personalization.definition });
      const snapshot = { ...current.snapshot, personalization };
      const contentHash = hash({ ...text, to: current.message.target_address, sender: snapshot.sender, replyTo: snapshot.replyTo, personalization });
      const event = this.eventRow(current.message, 'message_revised', this.now().toISOString(), {
        revisedBy, reason, previousContentHash: expectedHash, nextContentHash: contentHash,
        previousPersonalizationVersionId: current.snapshot.personalization.id, nextPersonalizationVersionId: personalization.id,
        previousStatus: current.message.status, previousApprovedBy: current.message.approved_by ?? null,
        note: 'Unversendete Nachricht mit stabiler ID überarbeitet; alte Inhaltsversion und Freigabeereignisse bleiben erhalten. Neue Freigabe erforderlich.'
      }, contentHash);
      await this.repo.transaction([
        { action: 'update', table: 'outreach_messages', id: messageId, data: { ...text, status: 'draft', approved_by: null, approved_at: null } },
        { action: 'update', table: 'outreach_enrollments', id: current.enrollment.$id, data: { content_hash: contentHash, snapshot_json: JSON.stringify(snapshot) } },
        { action: 'create', table: 'outreach_events', ...event }
      ]);
      return { messageId, status: 'draft', contentHash };
    });
  }
  async controls(patch) {
    return this.lock(async () => {
      const current = requireRow(await this.repo.get('outreach_controls', 'default'), 'Versandsteuerung');
      const allowed = ['paused', 'daily_limit', 'min_interval_seconds', 'timezone', 'start_hour', 'end_hour', 'weekdays_only'];
      if (Object.keys(patch).some(k => !allowed.includes(k))) throw new Error('Unbekannte Versandsteuerung.');
      const next = { ...current, ...patch };
      if (typeof next.paused !== 'boolean' || typeof next.weekdays_only !== 'boolean'
        || !Number.isInteger(next.daily_limit) || next.daily_limit < 0 || next.daily_limit > 100
        || !Number.isInteger(next.min_interval_seconds) || next.min_interval_seconds < 0 || next.min_interval_seconds > 86400
        || !Number.isInteger(next.start_hour) || !Number.isInteger(next.end_hour) || next.start_hour < 0 || next.end_hour > 24 || next.start_hour >= next.end_hour)
        throw new Error('Ungültige Versandgrenzen.');
      dayContext(this.now(), next.timezone);
      return this.repo.update('outreach_controls', 'default', patch);
    });
  }
  async experimentStatus({ experimentId, status }) {
    if (!['draft', 'active', 'paused', 'completed'].includes(status)) throw new Error('Ungültiger Experimentstatus.');
    return this.lock(async () => { requireRow(await this.repo.get('outreach_experiments', experimentId), 'Experiment'); return this.repo.update('outreach_experiments', experimentId, { status }); });
  }
  async sendOne({ messageId, execute = false }) {
    if (typeof execute !== 'boolean') throw new Error('execute muss ausdrücklich true oder false sein.');
    if (!execute) return { dryRun: true, ...(await this.preview(messageId)) };
    return this.lock(async () => {
      if (!this.provider) throw new Error('Versandanbieter fehlt.');
      if (this.provider.name === 'demo' && this.repo.database !== DEMO_DB) throw new Error('Demo-Transport darf keine echten Leads bearbeiten.');
      if (this.provider.name !== 'demo' && this.repo.database === DEMO_DB) throw new Error('Aus der Demo-Datenbank werden keine echten E-Mails versendet.');
      if (this.provider.name !== 'demo' && this.env.OUTREACH_SEND_ENABLED !== 'true') throw new Error('Live-Versand ist in der lokalen Konfiguration deaktiviert.');
      if(this.provider.name!=='demo'){
        const target=(await this.repo.get('outreach_messages',messageId))?.target_address;
        const domain=typeof target==='string'?target.split('@').at(-1).trim().toLowerCase():'';
        if(domain==='invalid'||domain.endsWith('.invalid'))throw new Error('Reservierte .invalid-Testadressen werden niemals echt versendet.');
      }
      const context = await this.context(messageId);
      if (context.message.status !== 'approved' || context.experiment.status !== 'active') throw new Error('Nachricht und Experiment sind nicht für Versand freigegeben.');
      await this.eligible(context);
      const definition = JSON.parse(context.experiment.definition_json).definition;
      if (definition.schemaVersion === 2 && (this.now().getTime() < Date.parse(definition.enrollmentWindow.startsAt) || this.now().getTime() >= Date.parse(definition.enrollmentWindow.endsAt))) throw new Error('Außerhalb des gemeinsamen Testfensters.');
      if (context.snapshot.sender.email !== email(this.env.OUTREACH_SENDER_EMAIL) || context.snapshot.sender.name !== this.env.OUTREACH_SENDER_NAME?.trim()
        || context.snapshot.replyTo !== email(this.env.OUTREACH_REPLY_TO_EMAIL)) throw new Error('Absenderkonfiguration unterscheidet sich vom freigegebenen Textstand.');
      const controls = requireRow(await this.repo.get('outreach_controls', 'default'), 'Versandsteuerung');
      const now = this.now();
      const day = dayContext(now, controls.timezone);
      if (controls.paused || controls.daily_limit === 0) throw new Error('Versand pausiert.');
      if (day.hour < controls.start_hour || day.hour >= controls.end_hour || (controls.weekdays_only && day.weekend)) throw new Error('Außerhalb des Versandfensters.');
      const attempts = await this.repo.list('outreach_attempts');
      if (attempts.some(a => a.message_id === messageId)) throw new Error('Versandversuch bereits vorhanden; erst Ergebnis abgleichen.');
      if (attempts.filter(a => dayKey(a.attempted_at) === dayKey(now)).length >= controls.daily_limit
        || attempts.filter(a => now - new Date(a.attempted_at) < 86400000).length >= controls.daily_limit) throw new Error('Tageslimit erreicht. Auch unklare Versuche zählen (Berlin und rollierende 24h).');
      if (attempts.some(a => now - new Date(a.attempted_at) < controls.min_interval_seconds * 1000)) throw new Error('Mindestabstand seit letztem Versandversuch noch nicht erreicht.');
      const ramp = await this.ramp.guard(context.snapshot.sender.email);
      if (this.provider.name !== 'demo') {
        const readiness = await this.provider.verify();
        if (!readiness.senderActive || !readiness.smtpEnabled) throw new Error('Brevo-Absender oder Versandkonto noch nicht aktiv.');
      }
      const attemptId = identity('att', messageId);
      const reservation = { client_id: context.message.client_id, message_id: messageId, day_key: dayKey(now),
        attempted_at: now.toISOString(), status: 'reserved', details_json: JSON.stringify({ transport: this.provider.name, contentHash: context.enrollment.content_hash, sender: context.snapshot.sender, ramp }) };
      // Durable reservation commits before the external side effect. Never retry this identity.
      await this.repo.transaction([
        { action: 'create', table: 'outreach_attempts', id: attemptId, data: reservation },
        { action: 'update', table: 'outreach_messages', id: messageId, data: { status: 'sending' } },
      ]);
      let sent;
      try {
        sent = await this.provider.send({ sender: context.snapshot.sender, replyTo: context.snapshot.replyTo,
          to: context.message.target_address, subject: context.message.subject, body: context.message.body }, attemptId);
      } catch (error) {
        const uncertain = error.uncertain !== false;
        await this.repo.transaction([
          { action: 'update', table: 'outreach_attempts', id: attemptId, data: { status: uncertain ? 'unknown' : 'rejected', details_json: JSON.stringify({ ...JSON.parse(reservation.details_json), outcome: uncertain ? 'unknown' : 'rejected' }) } },
          { action: 'update', table: 'outreach_messages', id: messageId, data: { status: uncertain ? 'sending' : 'failed' } },
        ]).catch(() => {});
        throw new Error(uncertain ? 'Versandstatus unklar. Keine Wiederholung; Ereignisse abgleichen.' : 'Anbieter hat den Versand abgelehnt. Ursache vor neuem Entwurf prüfen.');
      }
      const event = this.eventRow(context.message, 'provider_accepted', now.toISOString(), { provider: this.provider.name, messageId: sent.messageId }, attemptId);
      await this.repo.transaction([
        { action: 'update', table: 'outreach_attempts', id: attemptId, data: { status: 'accepted', provider_message_id: sent.messageId } },
        { action: 'update', table: 'outreach_messages', id: messageId, data: { status: 'sent', sent_at: now.toISOString(), provider_message_id: sent.messageId } },
        { action: 'create', table: 'outreach_events', ...event },
      ]);
      return { messageId, status: 'sent', providerMessageId: sent.messageId, delivered: false, transport: this.provider.name };
    });
  }
  eventRow(message, type, occurredAt, details, sourceId) {
    const key = hash([message.client_id, message.$id, type, sourceId]);
    return { id: identity('evt', key), data: { client_id: message.client_id, message_id: message.$id, event_key: key, event_type: type,
      occurred_at: utc(occurredAt), details_json: JSON.stringify(details) } };
  }
  async addEvent(message, type, occurredAt, details, sourceId) {
    const event = this.eventRow(message, type, occurredAt, details, sourceId);
    const existing = await this.repo.get('outreach_events', event.id);
    if (existing) {
      if (existing.event_type !== event.data.event_type || Date.parse(existing.occurred_at) !== Date.parse(event.data.occurred_at)
        || existing.details_json !== event.data.details_json) throw new Error('Ereigniskennung wurde mit anderem Inhalt erneut verwendet. Historie bleibt unverändert.');
      return { inserted: false, eventId: event.id };
    }
    await this.repo.create('outreach_events', event.id, event.data);
    return { inserted: true, eventId: event.id };
  }
  async suppress(message, reason, source) {
    const id = identity('sup', message.client_id, message.target_address);
    if (!await this.repo.get('outreach_suppressions', id)) await this.repo.create('outreach_suppressions', id, { client_id: message.client_id,
      email: message.target_address, reason, source, created_at: this.now().toISOString() });
    // Suspension is also written to the existing contact field for MCP users.
    await this.repo.update('contacts', message.contact_id, { do_not_contact: true });
  }
  async recordOutcome({ messageId, type, occurredAt, sourceId, source, note = '', booking, qualification }) {
    if (!outcomeTypes.has(type) || !sourceId?.trim() || !source?.trim() || typeof note !== 'string' || note.length > 20000) throw new Error('Ereignis braucht Typ, Quelle und eindeutige Quellkennung.');
    const time = utc(occurredAt);
    if (Date.parse(time) > this.now().getTime() + 300000) throw new Error('Ereignis liegt in der Zukunft.');
    return this.lock(async () => {
      const message = requireRow(await this.repo.get('outreach_messages', messageId), 'Nachricht');
      if (!['sent', 'sending'].includes(message.status)) throw new Error('Ergebnis kann keiner versandten/ungeklärten Nachricht zugeordnet werden.');
      const meeting = type.startsWith('meeting_');
      const context = await this.context(messageId);
      const v2 = JSON.parse(context.experiment.definition_json).definition.schemaVersion === 2;
      if (!meeting && (booking || qualification)) throw new Error('Buchungsdaten nur für Terminereignisse verwenden.');
      if (meeting && (v2 || booking || ['meeting_qualified', 'meeting_disqualified'].includes(type))) {
        if (!booking || Object.keys(booking).some(k => !['id', 'evidence'].includes(k))
          || typeof booking.id !== 'string' || !booking.id.trim() || booking.id.length > 255
          || typeof booking.evidence !== 'string' || !booking.evidence.trim() || booking.evidence.length > 4000) throw new Error('Terminereignis braucht Buchungskennung und konkreten Beleg.');
        if (type !== 'meeting_booked') {
          const booked = (await this.repo.list('outreach_events')).find(e => e.message_id === messageId && e.event_type === 'meeting_booked'
            && JSON.parse(e.details_json || '{}').booking?.id === booking.id && Date.parse(e.occurred_at) <= Date.parse(time));
          if (!booked) throw new Error('Passende frühere Buchung fehlt; positive Antwort ist keine Buchung.');
        }
      }
      if (type === 'meeting_qualified') {
        if (!qualification || Object.keys(qualification).some(k => !['need', 'decisionPath', 'checkedBy', 'evidence'].includes(k))
          || ['need', 'decisionPath', 'checkedBy', 'evidence'].some(k => typeof qualification[k] !== 'string' || !qualification[k].trim() || qualification[k].length > 4000))
          throw new Error('Qualifiziertes Gespräch braucht Bedarf, Weg zur Entscheidung, Prüfer und Beleg.');
      } else if (qualification) throw new Error('Qualifikation nur mit meeting_qualified speichern.');
      const attempts = (await this.repo.list('outreach_attempts')).filter(a => a.message_id === messageId);
      if (attempts.length && Date.parse(time) < Math.min(...attempts.map(a => Date.parse(a.attempted_at)))) throw new Error('Ergebnis liegt vor dem Versandversuch.');
      const result = await this.addEvent(message, type, time, { source, sourceId, note, ...(booking ? { booking } : {}), ...(qualification ? { qualification } : {}) }, hash([source, sourceId]));
      if (type === 'unsubscribed') await this.suppress(message, type, source);
      return result;
    });
  }
  async syncProvider({ maxMessages = 50, attemptIds } = {}) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100) throw new Error('Abgleichgrenze muss zwischen 1 und 100 liegen.');
    if (attemptIds !== undefined && (!Array.isArray(attemptIds) || !attemptIds.length || attemptIds.length > maxMessages
      || new Set(attemptIds).size !== attemptIds.length || attemptIds.some(id => typeof id !== 'string' || !/^[\w.-]{1,36}$/.test(id))))
      throw new Error('Gezielter Abgleich braucht eindeutige gültige Versandversuche innerhalb der Abgleichgrenze.');
    return this.lock(async () => {
      const attempts = (attemptIds ? await Promise.all(attemptIds.map(id => this.repo.get('outreach_attempts', id)))
        : await this.repo.list('outreach_attempts')).filter(a => a && ['reserved', 'accepted', 'unknown'].includes(a.status));
      const now = this.now();
      // The daemon deliberately revisits old messages: a click today can belong to
      // a mail sent months ago. The provider window limits event age, not mail age.
      const expired = attemptIds ? [] : attempts.filter(a => now - new Date(a.attempted_at) > 89 * 86400000);
      const current = attempts.filter(a => !expired.includes(a)).sort((a, b) => (JSON.parse(a.details_json).lastSyncAt ?? '').localeCompare(JSON.parse(b.details_json).lastSyncAt ?? ''));
      let inserted = 0, checked = 0;
      for (const attempt of current.slice(0, maxMessages)) {
        const message = requireRow(await this.repo.get('outreach_messages', attempt.message_id), 'Nachricht');
        const events = await this.provider.events({ messageId: attempt.provider_message_id || undefined, tag: attempt.$id, days: 90 });
        let recoveredId = null;
        for (const item of events) {
          if (email(item.email) !== message.target_address || typeof item.messageId !== 'string' || !item.messageId || item.messageId.length > 255) continue;
          if (attempt.provider_message_id ? item.messageId !== attempt.provider_message_id : !(item.tag === attempt.$id || item.tags?.includes(attempt.$id))) continue;
          if (recoveredId && recoveredId !== item.messageId) throw new Error('Mehrere Anbieterkennungen für einen Versandversuch; manuell prüfen.');
          const type = canonicalKind(item.event);
          const time = utc(item.date);
          if (Date.parse(time) < Date.parse(attempt.attempted_at) - 300000 || Date.parse(time) > now.getTime() + 300000) continue;
          recoveredId = item.messageId;
          const fields = { provider: this.provider.name, providerMessageId: item.messageId, rawEvent: String(item.event),
            reason: String(item.reason ?? '').slice(0, 1000), link: String(item.link ?? '').slice(0, 2048) };
          const result = await this.addEvent(message, type, time, fields, hash([this.provider.name, item.messageId, item.event, time, item.email, item.link ?? '']));
          inserted += Number(result.inserted);
          if (blocking.has(type)) await this.suppress(message, type, this.provider.name);
          if (type === 'complaint') await this.repo.update('outreach_controls', 'default', { paused: true });
        }
        if (recoveredId && attempt.status !== 'accepted') {
          await this.repo.transaction([
            { action: 'update', table: 'outreach_attempts', id: attempt.$id, data: { status: 'accepted', provider_message_id: recoveredId } },
            { action: 'update', table: 'outreach_messages', id: message.$id, data: { status: 'sent', provider_message_id: recoveredId, sent_at: attempt.attempted_at } },
          ]);
        }
        await this.repo.update('outreach_attempts', attempt.$id, { details_json: JSON.stringify({ ...JSON.parse(attempt.details_json), lastSyncAt: now.toISOString() }) });
        checked++;
      }
      return { checked, inserted, notCheckedThisRun: Math.max(0, current.length - checked), outsideApiWindow: expired.length,
        note: expired.length ? 'Ältere Versuche liegen außerhalb des abgefragten API-Zeitfensters.' : null };
    });
  }
  async report(experimentId) {
    const experiment = requireRow(await this.repo.get('outreach_experiments', experimentId), 'Experiment');
    const snapshot = JSON.parse(experiment.definition_json);
    const enrollments = (await this.repo.list('outreach_enrollments')).filter(e => e.experiment_id === experimentId);
    const messages = await this.repo.list('outreach_messages');
    const events = await this.repo.list('outreach_events');
    const attempts = await this.repo.list('outreach_attempts');
    return buildReport({ experiment, snapshot, enrollments, messages, events, attempts, now: this.now(), simulation: this.repo.database === DEMO_DB });
  }
}
