import type { NextConfig } from 'next';
import { join } from 'node:path';

// Рендерер собирается в статический экспорт (renderer/out) и отдаётся Electron через протокол app://
const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  devIndicators: false,
  // Корень проекта (а не C:\Users\<user> из-за чужого package-lock.json выше) — нужен и для импорта ../shared
  turbopack: { root: join(__dirname, '..') },
  // Не генерировать renderer/AGENTS.md и CLAUDE.md при `next dev`
  agentRules: false,
};

export default config;
