import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Meridian Agent Builder',
  description:
    'Build your own Meridian AI agent in a few clicks — private, local, and it remembers you.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="wordmark" style={{ textDecoration: 'none' }}>
              <span className="brand">Meridian</span>
              <span className="product">Agent Builder</span>
            </Link>
            <span className="trust-chip">
              <span className="dot" />
              Private by default — runs on this computer
            </span>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
