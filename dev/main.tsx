import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Stress from './Stress';
import Showcase from './Showcase';

// `npm run dev` opens the demo. Append `?stress` for the load-test harness, or
// `?shot=light` / `?shot=dark` for the README screenshot scene.
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {shot ? (
      <Showcase theme={shot === 'dark' ? 'dark' : 'light'} />
    ) : params.has('stress') ? (
      <Stress />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
