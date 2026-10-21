// src/format.ts
//
// Number/time formatting for on-screen text. One place, so every surface uses
// the same precision and typographic characters (narrow no-break space between
// value and unit, true minus sign, ellipsis).

import type { AgentStatus } from './types';

const NNBSP = ' '; // narrow no-break space: keeps "14.8 t/s" on one line
const MINUS = '−';

// Created on first use so importing this module has no side effects.
let rateNf: Intl.NumberFormat | undefined;
let intNf: Intl.NumberFormat | undefined;
const rateFmt = () =>
  (rateNf ??= new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const intFmt = () => (intNf ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }));

/** Token rate, e.g. `14.8 t/s`, `4,814 t/s` (no decimals from 100). Never renders NaN. */
export const formatRate = (v: number): string =>
  `${Number.isFinite(v) ? (Math.abs(v) >= 100 ? intFmt() : rateFmt()).format(v) : '–'}${NNBSP}t/s`;

/** Whole-number percentage, e.g. `42%`. */
export const formatPercent = (v: number): string =>
  Number.isFinite(v) ? `${intFmt().format(v)}%` : '–';

let tickNf: Intl.NumberFormat | undefined;
/** Axis value: integer when whole, otherwise one decimal (e.g. 12.5). */
export const formatAxisValue = (v: number): string =>
  Number.isFinite(v)
    ? (tickNf ??= new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })).format(v)
    : '–';

/** Integer, e.g. a health score. */
export const formatInt = (v: number): string => (Number.isFinite(v) ? intFmt().format(v) : '–');

/** Age of a sample: `now`, `2.4 s ago`, `1 m 05 s ago`. */
export const formatAgo = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 500) return 'now';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}${NNBSP}s ago`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}${NNBSP}m ${String(rem).padStart(2, '0')}${NNBSP}s ago`;
};

/** Relative time-axis tick: `now`, `−5s`, `−1m`, `−1m30s`. */
export const formatTick = (msBeforeEnd: number): string => {
  const s = Math.round(msBeforeEnd / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return `${MINUS}${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${MINUS}${m}m${rem}s` : `${MINUS}${m}m`;
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  active: 'Active',
  thinking: 'Thinking',
  stuck: 'Stuck',
  complete: 'Complete',
  hallucinating: 'Hallucinating',
};

export const formatStatus = (s: AgentStatus): string => STATUS_LABEL[s] ?? String(s);
