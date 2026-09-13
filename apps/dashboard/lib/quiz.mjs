const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

// Only an explicit website completion with its separate form snapshot is
// displayed as a completed quiz. Historical, incomplete events stay neutral.
export function quizEvidence(event) {
  if ((event?.type || event?.event_type) !== 'quiz_completed') return null;
  let details = event.details || {};
  if (event.details_json) { try { details = JSON.parse(event.details_json); } catch { return null; } }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const quiz = details.website_quiz;
  if (details.source !== 'sales-website' || !quiz || !uuid(quiz.event_id)
    || !uuid(quiz.source_submission_id) || typeof quiz.is_test !== 'boolean') return null;
  const contact = quiz.contact, result = quiz.result;
  if (!contact || contact.provenance !== 'quiz_form' || contact.source_submission_id !== quiz.source_submission_id
    || !['first_name', 'last_name', 'email', 'company'].every(key => text(contact[key]))
    || !Number.isFinite(Date.parse(contact.captured_at)) || (contact.phone != null && typeof contact.phone !== 'string')
    || !result || result.quiz_id !== 'sales-roadmap' || !text(result.quiz_version)
    || !Number.isInteger(result.stage) || result.stage < 0 || result.stage > 6) return null;
  return { ...quiz, contact, result };
}

export function quizCount(metric) {
  return metric?.unit === 'submissions' && Number.isInteger(metric.value) && metric.value >= 0 ? metric.value : null;
}
