import { profileIdentity } from '../../src/icp.mjs';
import { qualifyLead } from '../../src/qualification.mjs';

// Entirely invented test data. No source research, contact records or exports are used.
export function fictionalStorageResearch(profile) {
  const asOf = '2026-09-10';
  const evidence = (domain, facts) => Object.entries(facts).map(([fact, value]) => ({
    fact, value, confidence: 'confirmed', observedAt: asOf,
    source: { type: 'website', url: `https://${domain}/fixture`, quote: `Erfundener Testbeleg für ${fact}.` },
  }));
  const qualifiedFacts = {
    country: 'DE', employeeCount: 12, ownerLed: true, industry: 'organization_operations', consultingFocus: true,
    websiteExists: true, identityConfirmed: true, active: true, aiPracticeMaturity: 'building',
  };
  const specifications = [
    ['alpha', 'Fiktive Prozessberatung Alpha', qualifiedFacts],
    ['beta', 'Fiktive Organisationsberatung Beta', { ...qualifiedFacts, employeeCount: 18 }],
    ['gamma', 'Fiktiver ungeprüfter Kandidat Gamma', { country: 'DE' }],
    ['delta', 'Fiktiver Kleinstbetrieb Delta', { ...qualifiedFacts, employeeCount: 2 }],
    ['epsilon', 'Fiktive Personalvermittlung Epsilon', { ...qualifiedFacts, industry: 'recruiting' }],
  ];
  const leads = specifications.map(([id, name, facts]) => {
    const domain = `fixture-${id}.example`;
    return { id: `fictional-${id}`, name, website: `https://${domain}`, evidence: evidence(domain, facts) };
  });
  const results = leads.map((lead, index) => {
    const qualification = qualifyLead({ profile, lead, evidence: lead.evidence, asOf });
    const enrichment = index < 2 ? { status: 'completed', data: { contact: {
      name: index === 0 ? 'Fiktive Beispielperson Alpha' : 'Fiktives Beispielteam Beta',
      role: index === 0 ? 'Erfundene Geschäftsführung' : 'Erfundene Zentrale',
      email: `fixture-${index + 1}@example.invalid`, emailType: index === 0 ? 'Persönliche Testadresse' : 'Zentrale – Testadresse',
      source: `${lead.website}/team`, checkedAt: '2026-09-10T09:00:00Z',
    } } } : { status: 'skipped' };
    return { leadId: lead.id, qualification, enrichment };
  });
  return { leads, evaluation: { profile: profileIdentity(profile), asOf, results } };
}
