# Contributing

Thanks for helping. Bug reports with a reproduction are the most useful thing
you can send; pull requests are welcome too.

## Setup

```bash
npm ci
npm run dev          # demo at http://localhost:5173 (append ?stress for the load test)
npm test             # unit + component tests
npm run check        # everything CI runs: typecheck, lint, tests, build, size
npm run screenshots  # regenerate docs/screenshot-{light,dark}.png
```

Regenerate the screenshots after any visual change. The scene in
`dev/Showcase.tsx` is scripted and deterministic. Preview it at
`/?shot=light` or `/?shot=dark`.

For UI changes, also check the worst-case scenes in `dev/BreakIt.tsx`:
`/?break=many|menu|long|narrow|short|rtl|empty`, each with `&theme=dark` too.

Node 22.12 or newer.

## Layout

| Path | What's there |
|------|--------------|
| `src/AgentStat.tsx` | The component: roster, ingest, render loop, overlays |
| `src/timeseries.ts` | Time-indexed buffers, windowing, LTTB downsampling |
| `src/anomaly.ts` | Stall / spike / thrash detectors (pure functions) |
| `src/health.ts` | Health scoring |
| `src/statuslog.ts` | Sparse status-transition history |
| `src/theme.ts`, `src/color.ts`, `src/format.ts` | Tokens, color parsing, text formatting |
| `src/simulator.ts` | Seedable demo data |
| `dev/` | Demo app and stress harness (not published) |
| `tests/` | Vitest + Testing Library (happy-dom) |

## Principles

- **Never draw what didn't happen.** No backfilled history, no extrapolation
  past the last sample, no metric without a real input behind it.
- **Bad input must not break the chart.** Validate at the boundary; a frame that
  throws must not stop the loop.
- **Accessibility is a feature.** Keep text at WCAG AA contrast and keep
  keyboard paths for pointer interactions. Never use color as the only cue;
  respect `prefers-reduced-motion`.
- **Hot paths stay allocation-light.** The render loop reads refs, never React
  state; data writes don't re-render React.

## Pull requests

- Add a test for every bug fix (see `tests/regressions.test.tsx`).
- Run `npm run check` before pushing.
- Add an entry to `CHANGELOG.md` under the unreleased version.
- Keep the bundle within the budget in `scripts/check-size.mjs`. If you need to
  raise it, explain why.
