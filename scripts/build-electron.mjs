// Сборка main/preload процесса Electron через esbuild (TypeScript → CJS).
//   node scripts/build-electron.mjs          — dev-сборка с sourcemap
//   node scripts/build-electron.mjs --watch  — пересборка при изменениях (для F5 в VS Code)
//   node scripts/build-electron.mjs --prod   — минифицированная сборка
import { context, build } from 'esbuild';

const prod = process.argv.includes('--prod');
const watch = process.argv.includes('--watch');

const options = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !prod,
  minify: prod,
  external: ['electron'],
  logLevel: 'info',
  entryPoints: { main: 'electron/src/main.ts', preload: 'electron/src/preload.ts' },
  outdir: 'dist-electron',
};

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{
      name: 'watch-log',
      setup(b) {
        b.onStart(() => console.log('[watch] build started'));
        b.onEnd((r) => {
          // Однострочный формат для problemMatcher в .vscode/tasks.json: file:line:col: error: text
          for (const e of r.errors) {
            const l = e.location;
            console.log(l ? `${l.file}:${l.line}:${l.column + 1}: error: ${e.text}` : `error: ${e.text}`);
          }
          console.log(`[watch] build finished (${r.errors.length} errors)`);
        });
      },
    }],
  });
  await ctx.watch();
} else {
  await build(options);
}
