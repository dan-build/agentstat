import { defineConfig, type Options } from 'tsup';

const shared: Options = {
  format: ['esm', 'cjs'],
  dts: true,
  // Unminified on purpose: consumers minify, and keeping the output readable
  // preserves the pure annotations that let bundlers tree-shake it.
  minify: false,
  external: ['react', 'react-dom'],
  splitting: false,
  sourcemap: true,
  // The configs build in parallel, so neither may clean dist/: `npm run
  // build` empties it first.
  clean: false,
  esbuildOptions(options) {
    // Internal members are named with a leading underscore so the build can
    // shorten them; nothing public may start with one.
    options.mangleProps = /^_/;
  },
};

export default defineConfig([
  {
    ...shared,
    entry: ['src/index.ts'],
    // Bundling drops module-level directives, so restore it: without it,
    // importing the component from a React Server Component (Next.js App
    // Router) fails on the first hook.
    banner: { js: "'use client';" },
  },
  {
    ...shared,
    // Adapters: no React and no client directive, so they also run on the
    // server (route handlers, workers).
    entry: ['src/ai-sdk.ts', 'src/ag-ui.ts', 'src/langchain.ts', 'src/sse.ts', 'src/otel.ts'],
  },
]);
