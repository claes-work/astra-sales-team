import { dashboardConfig } from '@/lib/runtime.mjs';
export function GET() {
  let mode;
  try { mode = dashboardConfig().mode; }
  catch { return Response.json({ app: 'sales-dashboard', status: 'unconfigured' }, { status: 503 }); }
  return Response.json({ app: 'sales-dashboard', version: '0.1.0', mode: mode === 'local' && process.env.DASHBOARD_TEST_MODE === 'true' ? 'demo' : mode }, { headers: { 'Cache-Control': 'no-store' } });
}
