'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const paths = [{ href: '/days', title: 'Tage', icon: 'days' }, { href: '/leads', title: 'Leads', icon: 'leads' }];
function Icon({ name }: { name: string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" aria-hidden="true">{name === 'overview' ? <><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><path d="M4 15h16M4 20h16"/></> : name === 'leads' ? <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/></> : <><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 11h16M8 15h3M8 18h6"/></>}</svg>;
}
export function Navigation() {
  const pathname = usePathname();
  return <nav aria-label="Hauptnavigation">{paths.map(p => { const active = p.href === '/' ? pathname === '/' : pathname.startsWith(p.href) || p.href === '/leads' && (pathname.startsWith('/messages') || pathname.startsWith('/drafts')); return <Link key={p.href} href={p.href} className={active ? 'nav-link active' : 'nav-link'} aria-current={active ? 'page' : undefined}><Icon name={p.icon}/>{p.title}</Link>; })}</nav>;
}
