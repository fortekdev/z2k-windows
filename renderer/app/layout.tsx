import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'z2k Windows — Создано в RuBot.Cloud' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
