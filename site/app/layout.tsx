import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? 'http://localhost:3000'),
  title: 'FilingLens | SEC Filing Intelligence',
  description:
    'Evidence-linked financial and risk intelligence for public-company SEC filings.',
  openGraph: {
    title: 'FilingLens | SEC Filing Intelligence',
    description: 'Research public-company filings and verify every result with SEC evidence.',
    images: [{ url: '/og.png', width: 1792, height: 1024, alt: 'FilingLens evidence-linked SEC filing intelligence' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FilingLens | SEC Filing Intelligence',
    description: 'Research public-company filings and verify every result with SEC evidence.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
