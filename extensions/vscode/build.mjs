// Two bundles: the extension (Node, in the extension host) and the panel
// (browser, in a webview). The panel is built from this repo's own src/, so it
// always matches the library.
/* global console, process */
import { build } from 'esbuild';

const prod = process.argv.includes('--dev') ? false : true;
await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    minify: prod,
    logLevel: 'warning',
  }),
  build({
    entryPoints: ['src/webview/main.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outfile: 'dist/webview.js',
    minify: prod,
    define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
    logLevel: 'warning',
  }),
]);
console.log('built dist/extension.js and dist/webview.js');
