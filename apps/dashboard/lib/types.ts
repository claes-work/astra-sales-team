export type Row = Record<string, any>;
export type Lead = {
  $id: string; name: string; domain?: string; website?: string; fit: string; grade?: string;
  reason?: string; researchStatus?: string; outreachStatus?: string; blocked: boolean; blockReason?: string;
  positiveResponse?: boolean; isNew?: boolean; createdAt?: string; lastResearchAt?: string; do_not_contact?: boolean;
};
export type LeadPage = { page: number; pageSize: number; total: number; items: Lead[] };
export type LeadDetail = { company: Lead; assessments: Row[]; contacts: Row[]; messages: Row[]; activities: Row[]; drafts?: Row[]; quizSubmissions?: Row[] };
export type Overview = { asOf: string; timezone: string; totals: Row; today: DayDetail; days: Row[]; controls: Row | null; ramp: Row; limitations: Row | string[]; success?: Row; usage?: Row; recentActivity?: Row[] };
export type DayDetail = { day: string; timezone: string; counts: Row; pipeline: Row; sent: Row[]; events: Row[]; variableCosts: Row; reporting?: Row; funnel?: Row; quizSubmissions?: Row[] };
export type MessageDetail = { id: string; companyId: string; companyName: string; subject: string; body: string; to: string; sender: Row; replyTo: string; status: string; sentAt: string | null; sentAtIsProxy: boolean | null; sentAtSource: string | null; acceptedAt: string | null; deliveredAt: string | null; snapshotVerified: boolean; timeline: Row[]; tracking: Row; frozen?: Row };
