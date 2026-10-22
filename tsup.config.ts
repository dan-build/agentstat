import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Unminified on purpose: consumers minify, and keeping the output readable
  // preserves the pure annotations that let bundlers tree-shake it.
  minify: false,
  external: ['react', 'react-dom'],
  splitting: false,
  sourcemap: true,
  // Bundling drops module-level directives, so restore it: without it,
  // importing the component from a React Server Component (Next.js App
  // Router) fails on the first hook.
  banner: { js: "'use client';" },
  esbuildOptions(options) {
    // Internal members are named with a leading underscore so the build can
    // shorten them; nothing public may start with one.
    options.mangleProps = /^_/;
  },
});
