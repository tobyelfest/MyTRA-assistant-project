import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MyTRA AI',
  description: 'Asisten layanan akuntansi dan perpajakan PT KJA MyTRA Makmur Abadi.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
