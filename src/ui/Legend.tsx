// src/ui/Legend.tsx
//
// One row of agent toggles. Whatever doesn't fit moves into a "+N" menu with
// a "Show all agents" shortcut; the menu closes on Escape (returning focus to
// its trigger) or on a press outside it.

import React, { useEffect, useId, useRef, useState } from 'react';
import type { RowSnapshot } from '../core/store';
import { FONT_SANS } from '../theme';

// Measure UI text with the same font the chips use. Falls back to an average
// glyph width where canvas text metrics aren't available.
let measureCtx: CanvasRenderingContext2D | null | undefined;
const measureChipText = (text: string): number => {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  const w =
    measureCtx && typeof measureCtx.measureText === 'function'
      ? ((measureCtx.font = `500 12px ${FONT_SANS}`), measureCtx.measureText(text).width)
      : 0;
  return w > 0 ? w : text.length * 6.8;
};
// Chip chrome: padding (2 × 10) + swatch (8) + gap (6).
const CHIP_CHROME = 34;
const CHIP_TEXT_MAX = 16 * 7; // matches the 16ch max width
const MORE_CHIP = 48;
const PAUSE_CHIP = 96;

/** How many chips fit on one row of `width` px (all of them before measuring). */
const fitChips = (rows: RowSnapshot[], width: number): number => {
  if (width <= 0) return rows.length;
  const available = width - 24 - PAUSE_CHIP - 8;
  const widths = rows.map((r) => Math.min(CHIP_TEXT_MAX, measureChipText(r.name)) + CHIP_CHROME);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1) * 4;
  if (total <= available) return rows.length;
  let used = MORE_CHIP;
  let n = 0;
  while (n < widths.length && used + widths[n] + 4 <= available) {
    used += widths[n] + 4;
    n++;
  }
  return n;
};

/** Legend chip / menu row that shows or hides one agent. */
export const AgentToggle = ({
  row,
  color,
  onToggle,
}: {
  row: RowSnapshot;
  color: string;
  onToggle: (id: string) => void;
}) => (
  <button
    type="button"
    className={`agentstat-btn agentstat-surface${row.visible ? '' : ' is-off'}`}
    aria-pressed={row.visible}
    title={row.name}
    onClick={() => onToggle(row.id)}
    style={{ '--c': color } as React.CSSProperties}
  >
    <span className="agentstat-swatch" aria-hidden="true" />
    <span className="agentstat-name">
      <bdi>{row.name}</bdi>
    </span>
  </button>
);

export function Legend({
  rows,
  colorFor,
  width,
  onToggle,
  onShowAll,
}: {
  rows: RowSnapshot[];
  colorFor: (r: RowSnapshot) => string;
  /** Chart width in CSS px; 0 until measured. */
  width: number;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the overflow menu on a pointer press outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || moreBtnRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  if (rows.length === 0) return null;
  const chipCount = fitChips(rows, width);
  const chipRows = rows.slice(0, chipCount);
  const overflowRows = rows.slice(chipCount);
  const hiddenCount = rows.filter((r) => !r.visible).length;

  return (
    <>
      <div className="agentstat-legend" role="group" aria-label="Agents">
        {chipRows.map((r) => (
          <AgentToggle key={r.id} row={r} color={colorFor(r)} onToggle={onToggle} />
        ))}
        {overflowRows.length > 0 && (
          <button
            ref={moreBtnRef}
            type="button"
            className="agentstat-btn agentstat-surface agentstat-more-btn"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={`${overflowRows.length} more agent${overflowRows.length === 1 ? '' : 's'}`}
            onClick={() => setMenuOpen((o) => !o)}
          >
            +{overflowRows.length}
          </button>
        )}
      </div>

      {menuOpen && overflowRows.length > 0 && (
        <div
          ref={menuRef}
          id={menuId}
          className="agentstat-menu agentstat-surface"
          role="group"
          aria-label="More agents"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setMenuOpen(false);
              moreBtnRef.current?.focus();
            }
          }}
        >
          {hiddenCount > 0 && (
            <button type="button" className="agentstat-btn agentstat-menu-all" onClick={onShowAll}>
              Show all agents
            </button>
          )}
          {overflowRows.map((r) => (
            <AgentToggle key={r.id} row={r} color={colorFor(r)} onToggle={onToggle} />
          ))}
        </div>
      )}
    </>
  );
}
