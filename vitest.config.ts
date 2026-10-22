import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    // Runs against the build; see vitest.dist.config.ts (`npm run test:dist`).
    exclude: ['tests/dist-smoke.test.tsx', 'node_modules/**'],
    setupFiles: ['tests/setup.ts'],
  },
});
