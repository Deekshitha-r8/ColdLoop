import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from './engine/world.js';
import { whatIf } from './engine/whatif.js';
import { llmReader, ruleReader } from './engine/reader.js';
import { product, site, products, sites, carriers } from './engine/data.js';
import { runHarness } from './harness.js';
import { runAttacks } from './attacks.js';

let world = new World();
const reader = llmReader() ?? ruleReader;
const app = express();
app.use(express.json());
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../public');

app.use(express.static(publicDir));
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const wrap = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  try { const out = await fn(req, res); if (out !== undefined) res.json(out); } catch (e: any) { res.status(400).json({ error: e.message }); }
};
const summary = (id: string) => {
  const s = world.ship(id); const c = world.cases.get(id);
  return { id, product: product(s.productId).name, productId: s.productId, qty: s.qty, dest: site(s.dest).name, tier: s.tier, clinicDaysStock: s.clinicDaysStock,
    lane: world.laneFor(s).some(i => i.severity === 'high'), alarmReason: s.alarmReason, status: c?.status ?? 'new', disposition: c?.disposition ?? null, usedPct: c?.ledger?.usedPct ?? null, flags: c?.flags ?? [] };
};

app.get('/api/meta', wrap(() => ({ reader: reader.name, liveLLM: reader !== ruleReader, feed: world.feed.label, policy: world.policy, products, sites, carriers, dataNotice: 'ALL DATA IS SYNTHETIC. Not for clinical use.' })));
app.get('/api/shipments', wrap(() => world.shipments.map(s => summary(s.id))));
app.get('/api/shipments/:id', wrap(req => { const s = world.ship(req.params.id); return { ...s, full: undefined, product: product(s.productId), destSite: site(s.dest) }; }));
app.post('/api/cases/:id/run', wrap(async req => world.runCase(req.params.id, { aiMode: req.body?.aiMode !== false, reader })));
app.post('/api/run-all', wrap(async () => ({ ranking: await world.runAll({ reader }), impact: world.impact() })));
app.get('/api/cases/:id', wrap(req => world.cases.get(req.params.id) ?? null));
app.post('/api/cases/:id/qa', wrap(req => world.qaDecide(req.params.id, req.body.token, req.body.decision, req.body.reason ?? '', !!req.body.override)));
app.post('/api/cases/:id/approve-spend', wrap(req => world.approveSpend(req.params.id, req.body.token, req.body.reason ?? '')));
app.get('/api/cases/:id/report', (req, res) => {
  const c = world.cases.get(req.params.id); if (!c) return res.status(404).send('Run the case first.');
  const s = world.ship(c.shipmentId); const rows = world.audit.entries.filter(e => (e.data as any).shipment === s.id);
  const esc = (x: unknown) => String(x).replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]!));
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>Audit report ${s.id}</title><style>body{font:14px system-ui;max-width:900px;margin:24px auto;padding:0 16px}td,th{border:1px solid #ccc;padding:4px 6px;font-size:12px;vertical-align:top}table{border-collapse:collapse;width:100%}code{font-size:11px}</style>
  <h1>ColdLoop audit report - ${s.id}</h1><p><b>SYNTHETIC DATA. Simulated budgets. Not a regulatory record.</b></p>
  <p>Disposition: <b>${c.disposition}</b> - Status: <b>${c.status}</b> - Chain integrity: <b>${world.audit.verify().ok ? 'VERIFIED' : 'BROKEN'}</b></p>
  <h2>Explanation</h2><p>${esc(c.explanation)}</p><h2>Claims and sources</h2><table><tr><th>#</th><th>Kind</th><th>Claim</th><th>Source</th><th>Quote</th></tr>${(c.dossier ?? []).map(d => `<tr><td>${d.id}</td><td>${d.kind}</td><td>${esc(d.text)}</td><td>${esc(d.source)}</td><td>${esc(d.quote ?? '')}</td></tr>`).join('')}</table>
  <h2>Audit trail</h2><table><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Rationale</th><th>Source</th><th>Hash</th></tr>${rows.map(e => `<tr><td>${e.idx}</td><td>${e.ts}</td><td>${e.actor}</td><td>${e.action}</td><td>${esc(e.rationale)}</td><td>${esc(e.source)}</td><td><code>${e.hash.slice(0, 16)}...</code></td></tr>`).join('')}</table>
  <script>print()</script>`);
});
app.get('/api/rank', wrap(() => world.rank()));
app.get('/api/impact', wrap(() => world.impact()));
app.get('/api/lane-feed', wrap(() => world.feed));
app.get('/api/audit', wrap(() => ({ integrity: world.audit.verify(), entries: world.audit.entries })));
app.post('/api/audit/tamper', wrap(req => { world.audit.tamper(Number(req.body?.idx ?? 3)); return world.audit.verify(); }));
app.post('/api/whatif', wrap(async req => whatIf(world, req.body)));
app.get('/api/tests/harness', wrap(async () => { const r = await runHarness(); return { ...r, rows: undefined }; }));
app.get('/api/tests/attacks', wrap(async () => runAttacks()));
app.post('/api/reset', wrap(() => { world = new World(); return { ok: true }; }));

// SAP CAP / OData v4-shaped read endpoints (shape only - this is NOT a real CAP service; see README)
const odata = (name: string, value: unknown[]) => ({ '@odata.context': `$metadata#${name}`, value });
app.get('/odata/v4/coldloop/Shipments', wrap(() => odata('Shipments', world.shipments.map(s => summary(s.id)))));
app.get('/odata/v4/coldloop/Cases', wrap(() => odata('Cases', [...world.cases.values()].map(c => ({ shipmentId: c.shipmentId, status: c.status, disposition: c.disposition, usedPct: c.ledger?.usedPct })))));
app.get('/odata/v4/coldloop/AuditLog', wrap(() => odata('AuditLog', world.audit.entries)));

const port = Number(process.env.PORT ?? 4004);
app.listen(port, () => console.log(`ColdLoop on http://localhost:${port}  (reader: ${reader.name}; data: SYNTHETIC)`));
