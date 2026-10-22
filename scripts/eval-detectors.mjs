// Labelled evaluation of the anomaly detectors (stall, spike, thrash).
//
//   node scripts/eval-detectors.mjs            # table per scenario + totals
//   node scripts/eval-detectors.mjs --json     # machine-readable results
//   node scripts/eval-detectors.mjs --verbose  # also list every alert
//
// Bundles scripts/eval/scenarios.ts (which imports the real AgentStore and
// detectors from src/) with esbuild, so it always measures the code in this
// checkout. Deterministic: every scenario is seeded (mulberry32) and runs on a
// simulated clock (10 Hz samples, health tick every 500 ms).
/* global Buffer, URL, console, performance, process */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const out = await build({
  entryPoints: [fileURLToPath(new URL('./eval/scenarios.ts', import.meta.url))],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const { runAll, DEFAULT_ANOMALY_CONFIG, TOLERANCE_MS } = await import(
  'data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64')
);

const args = new Set(process.argv.slice(2));
const t0 = performance.now();
const results = runAll();
const elapsedMs = performance.now() - t0;

const sum = (f) => results.reduce((s, r) => s + f(r), 0);
const tp = sum((r) => r.tp);
const misses = sum((r) => r.misses);
const fp = sum((r) => r.fp);
// Alerts matched to a required label (repeats included) vs. unmatched ones.
const truePosAlerts = sum((r) => r.alerts.filter((a) => a.label >= 0 && !r.labels[a.label].optional).length);
const agentHours = sum((r) => (r.agents * r.durationS) / 3600);
const allLatencies = results.flatMap((r) => r.latencies);
const sortedLat = [...allLatencies].sort((a, b) => a - b);
const med = sortedLat.length
  ? sortedLat.length % 2
    ? sortedLat[sortedLat.length >> 1]
    : (sortedLat[sortedLat.length / 2 - 1] + sortedLat[sortedLat.length / 2]) / 2
  : null;
const fpByKind = {};
for (const r of results) for (const [k, v] of Object.entries(r.fpByKind)) fpByKind[k] = (fpByKind[k] ?? 0) + v;

const totals = {
  scenarios: results.length,
  alerts: sum((r) => r.alerts.length),
  tp,
  fp,
  misses,
  allowed: sum((r) => r.allowed),
  precision: truePosAlerts + fp ? truePosAlerts / (truePosAlerts + fp) : null,
  recall: tp + misses ? tp / (tp + misses) : null,
  agentHours,
  fpPerAgentHour: fp / agentHours,
  fpByKind,
  medianLatencyS: med,
  maxAlertsPerEpisode: Math.max(0, ...results.map((r) => r.maxPerEpisode)),
  elapsedMs: Math.round(elapsedMs),
};

if (args.has('--json')) {
  console.log(JSON.stringify({ config: DEFAULT_ANOMALY_CONFIG, toleranceMs: TOLERANCE_MS, totals, results }, null, 2));
} else {
  const cols = ['scenario', 'agents', 'dur', 'alerts', 'TP', 'FP', 'miss', 'allow', 'lat(s)', 'max/ep', 'FP kinds'];
  const rows = results.map((r) => [
    r.name,
    r.agents,
    `${r.durationS}s`,
    r.alerts.length,
    r.tp,
    r.fp,
    r.misses,
    r.allowed,
    r.medianLatencyS === null ? '-' : r.medianLatencyS.toFixed(1),
    r.maxPerEpisode || '-',
    Object.entries(r.fpByKind).map(([k, v]) => `${k}×${v}`).join(' ') || '-',
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => String(row[i]).length)));
  const line = (row) => row.map((v, i) => (i === 0 || i === row.length - 1 ? String(v).padEnd(w[i]) : String(v).padStart(w[i]))).join('  ');
  console.log(line(cols));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const row of rows) console.log(line(row));
  const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
  console.log(
    `\nprecision ${pct(totals.precision)} · recall ${pct(totals.recall)} (${tp}/${tp + misses} labels) · ` +
      `FP ${fp} over ${agentHours.toFixed(2)} agent-h = ${totals.fpPerAgentHour.toFixed(1)}/agent-h · ` +
      `median TP latency ${med === null ? '-' : med.toFixed(1) + 's'} · max alerts/episode ${totals.maxAlertsPerEpisode} · ${totals.elapsedMs} ms`
  );
  if (args.has('--verbose')) {
    for (const r of results) {
      for (const a of r.alerts) {
        const tag = a.label < 0 ? 'FP ' : r.labels[a.label].optional ? 'OK?' : 'TP ';
        console.log(`${tag} ${r.name} a${a.agent} @${a.t.toFixed(1)}s ${a.kind}/${a.severity}: ${a.message}`);
      }
      for (const l of r.labels) if (!l.optional && !l.hit) console.log(`MISS ${r.name} a${l.agentIdx} ${l.kind} [${l.start}, ${l.end}]`);
    }
  }
}
