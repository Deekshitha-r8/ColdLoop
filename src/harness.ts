// Test harness: every scenario x 3 setups. The DECISION must be identical whether the AI is on, off, or hostile.
import { World } from './engine/world.js';
import { hostileReader, ruleReader } from './engine/reader.js';

export async function runHarness() {
  const setups = [
    { name: 'AI on (offline reader)', opts: { aiMode: true, reader: ruleReader } },
    { name: 'AI off (template)', opts: { aiMode: false } },
    { name: 'Hostile AI reader', opts: { aiMode: true, reader: hostileReader } },
  ];
  const results: Record<string, Record<string, string>> = {};
  const stats = setups.map(s => ({ setup: s.name, cases: 0, hallucinatedFactsDropped: 0, factsKept: 0, unauthorisedToolSuccesses: 0, auditChainOk: false }));
  for (const [i, su] of setups.entries()) {
    const w = new World();
    for (const sh of w.shipments) {
      const c = await w.runCase(sh.id, su.opts);
      (results[sh.id] ??= {})[su.name] = `${c.disposition}`;
      stats[i].cases++; stats[i].factsKept += c.facts.length; stats[i].hallucinatedFactsDropped += c.droppedFacts.length;
      stats[i].unauthorisedToolSuccesses += c.trace.filter(t => (t.tool === 'qa_release' || t.tool === 'qa_reject') && t.allowed).length;
    }
    stats[i].auditChainOk = w.audit.verify().ok;
  }
  const rows = Object.entries(results).map(([id, r]) => ({ id, ...r, identical: new Set(Object.values(r)).size === 1 }));
  const mismatches = rows.filter(r => !r.identical);
  const dist: Record<string, number> = {};
  rows.forEach(r => { const d = r[setups[0].name as keyof typeof r] as string; dist[d] = (dist[d] ?? 0) + 1; });
  return { scenarios: rows.length, setups: setups.map(s => s.name), decisionsIdenticalAcrossSetups: mismatches.length === 0, mismatches, dispositionMix: dist, stats, rows };
}

if (process.argv[1]?.endsWith('harness.ts')) {
  const r = await runHarness();
  console.log(`Scenarios: ${r.scenarios} x ${r.setups.length} setups`);
  console.log('Disposition mix:', r.dispositionMix);
  console.table(r.stats);
  console.log(r.decisionsIdenticalAcrossSetups ? 'PASS: decision identical in every setup (AI cannot change the verdict)' : `FAIL: ${r.mismatches.length} mismatches`);
  if (!r.decisionsIdenticalAcrossSetups) process.exit(1);
}
