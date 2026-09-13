import type { Metadata } from 'next';
import { AppShell } from '@/components/app-shell';
import './globals.css';

export const metadata: Metadata = { title: { default: 'Tage · Sales-Team', template: '%s · Sales-Team' }, description: 'Internes Vertriebsdashboard.', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="de"><body><AppShell protectedMode={process.env.DASHBOARD_MODE === 'production'} demo={process.env.DASHBOARD_TEST_MODE === 'true'}>{children}</AppShell></body></html>;
}
