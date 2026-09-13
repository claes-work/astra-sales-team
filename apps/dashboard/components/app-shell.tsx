'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Navigation } from './navigation';

export function AppShell({ children, protectedMode, demo }: { children: React.ReactNode; protectedMode: boolean; demo: boolean }) {
  const pathname = usePathname();
  if (pathname === '/login') return <main className="login-shell" id="main">{children}</main>;
  return <><a className="skip-link" href="#main">Zum Inhalt</a><div className="app-shell"><aside className="sidebar"><Link href="/" className="brand">Sales</Link><Navigation/>{protectedMode && <form className="logout-form" action="/api/auth/logout" method="post"><button type="submit" className="logout-button">Abmelden</button></form>}</aside><div className="workspace"><main id="main">{demo && <p className="demo-banner">Demo · ausschließlich fiktive Daten</p>}{children}</main></div></div></>;
}
