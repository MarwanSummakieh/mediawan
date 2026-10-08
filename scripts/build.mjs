import { build } from 'esbuild';
await build({
  entryPoints: ['public/app.js'],
  bundle: true,
  format: 'iife',
  target: 'chrome69',
  outfile: 'public/app.bundle.js',
  legalComments: 'none',
  sourcemap: false,
});
console.log('Built Mediawan for browsers and Tizen Chromium 69.');
