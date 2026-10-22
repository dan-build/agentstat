import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Smoke-tests the built package (dist/). Run after `npm run build`.
// Standalone rather than merged: mergeConfig would concatenate `include`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/dist-smoke.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
