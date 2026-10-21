import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Stress from './Stress';

// `npm run dev` opens the demo; append `?stress` for the load-test harness.
const isStress = new URLSearchParams(window.location.search).has('stress');

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isStress ? <Stress /> : <App />}</React.StrictMode>
);
