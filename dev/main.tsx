import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Stress from './Stress';
import Showcase from './Showcase';
import BreakIt from './BreakIt';

// `npm run dev` opens the demo. Append `?stress` for the load-test harness, or
// `?shot=light` / `?shot=dark` for the README screenshot scene, or
// `?break=many|long|narrow|short|rtl|empty` for worst-case UI scenes.
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const brk = params.get('break');
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {brk ? (
      <BreakIt scene={brk as Parameters<typeof BreakIt>[0]['scene']} theme={theme} />
    ) : shot ? (
      <Showcase theme={shot === 'dark' ? 'dark' : 'light'} />
    ) : params.has('stress') ? (
      <Stress />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
