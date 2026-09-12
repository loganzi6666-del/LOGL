#!/usr/bin/env node
/**
 * Bundles the browser code into public/dist/app.js.
 *
 * d3 is bundled rather than loaded from a CDN so the game runs with no network
 * at all — which matters, because the only thing it should ever need the
 * internet for is the language model.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'public/js/main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: path.join(root, 'public/dist/app.js'),
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('클라이언트 번들 감시 중…');
} else {
  await esbuild.build(options);
}
