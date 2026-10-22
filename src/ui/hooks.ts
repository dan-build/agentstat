// src/ui/hooks.ts — small browser hooks, all safe during server rendering.

import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

/** Subscribe to a media query, tolerating engines that only have addListener. */
export const watchMedia = (query: string, cb: (matches: boolean) => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(query);
  const handler = () => cb(mq.matches);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  mq.addListener?.(handler);
  return () => mq.removeListener?.(handler);
};

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// useLayoutEffect warns during server rendering in React 18; it only matters
// in the browser anyway.
export const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Live value of a media query; false during server rendering or when disabled. */
export const useMediaQuery = (query: string, enabled = true): boolean =>
  useSyncExternalStore(
    useCallback((onChange: () => void) => (enabled ? watchMedia(query, onChange) : () => {}), [query, enabled]),
    () =>
      enabled &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
    () => false
  );
