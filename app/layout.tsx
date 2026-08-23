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
  metadataBase: new URL('https://reinickendorf-akquise-os.schnetzer-vincent.chatgpt.site'),
  title: 'Reinickendorf Akquise OS',
  description: 'Intelligentes CRM für lokale Neukundenakquise in Berlin-Reinickendorf.',
  openGraph: {
    title: 'Reinickendorf Akquise OS',
    description: 'Intelligentes CRM für lokale Neukundenakquise.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Reinickendorf Akquise OS',
    description: 'Intelligentes CRM für lokale Neukundenakquise.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <head>
        <meta property="og:image" content="https://reinickendorf-akquise-os.schnetzer-vincent.chatgpt.site/og.png" />
        <meta property="og:image:width" content="1536" />
        <meta property="og:image:height" content="1024" />
        <meta property="og:image:alt" content="Reinickendorf Akquise OS" />
        <meta name="twitter:image" content="https://reinickendorf-akquise-os.schnetzer-vincent.chatgpt.site/og.png" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
