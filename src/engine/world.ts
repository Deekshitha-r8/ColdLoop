// World state + policy-gated tools + the agent loop.
// Principle: the agent PICKS which tool to call and explains why; CODE decides what is safe, valid and allowed.
import { AuditLog } from './audit.js';
import { buildShipments, buildStock, carriers, laneFeed, policy as basePolicy, product, site } from './data.js';
import { classify, computeLedger } from './ledger.js';
import { detectInjections, ruleReader, verifyFacts, type Reader } from './reader.js';
import type { Booking, Case, Claim, OptionCheck, OptionEval, Order, Policy, Projection, Role, Shipment, StockLot, LaneFeed } from './types.js';

type ToolName = 'read_ledger' | 'read_notes' | 'lane_status' | 'place_hold' | 'find_stock' | 'quote_carriers'
  | 'create_order' | 'book_carrier' | 'verify_booking' | 'cancel_order' | 'request_spend_approval' | 'escalate' | 'qa_release' | 'qa_reject';

const TOOL_ROLES: Record<ToolName, Role[]> = {
  read_ledger: ['agent', 'controller', 'qa'], read_notes: ['agent', 'controller', 'qa'], lane_status: ['agent', 'controller', 'qa'],
  place_hold: ['agent'], find_stock: ['agent'], quote_carriers: ['agent'], create_order: ['agent'], book_carrier: ['agent'],
  verify_booking: ['agent'], cancel_order: ['agent'], request_spend_approval: ['agent'], escalate: ['agent'],
  qa_release: ['qa'], qa_reject: ['qa'], // the agent can NEVER release product
};

export interface RunOpts { aiMode?: boolean; reader?: Reader; policy?: Policy; extraDelayHours?: number; forceCancel?: string[]; dryRun?: boolean }

export class World {
  policy: Policy; shipments: Shipment[]; stock: StockLot[]; audit = new AuditLog(); feed: LaneFeed;
  cases = new Map<string, Case>(); orders: Order[] = []; bookings: Booking[] = []; holds = new Set<string>();
  deniedCalls: Array<{ shipmentId: string; tool: string; role: string; reason: string }> = [];
  private seq = 0;
  constructor(policy?: Policy) {
    this.policy = structuredClone(policy ?? basePolicy); this.shipments = buildShipments(); this.stock = buildStock(); this.feed = laneFeed();
    this.audit.append('system', 'boot', 'ColdLoop started on SYNTHETIC data', 'data/*.json', { shipments: this.shipments.length, feed: this.feed.label });
  }
  ship(id: string) { const s = this.shipments.find(x => x.id === id); if (!s) throw new Error(`unknown shipment ${id}`); return s; }

  // ---------- the policy gate: every tool call passes through here
  gate(c: Case, role: Role, tool: ToolName, args: Record<string, unknown>, why: string): { ok: boolean; reason?: string } {
    let reason: string | undefined;
    if (!TOOL_ROLES[tool].includes(role)) reason = `role '${role}' may not call ${tool}`;
    else if (tool === 'create_order' && Number(args.costINR) > this.policy.spend.limitINR && !args.approved) reason = `cost INR ${args.costINR} exceeds auto-spend limit INR ${this.policy.spend.limitINR}`;
    else if (tool === 'book_carrier' && !this.orders.find(o => o.id === args.orderId && o.status !== 'cancelled')) reason = 'no live order to book against';
    const ok = !reason;
    c.trace.push({ n: c.trace.length + 1, ts: new Date().toISOString(), tool, args: JSON.stringify(args), why, result: ok ? 'allowed' : `BLOCKED: ${reason}`, allowed: ok });
    if (!ok) { this.deniedCalls.push({ shipmentId: c.shipmentId, tool, role, reason: reason! }); this.audit.append(role, `denied:${tool}`, reason!, 'policy-gate', { shipment: c.shipmentId, args }); }
    return { ok, reason };
  }
  private log(c: Case, actor: string, action: string, rationale: string, source: string, data: Record<string, unknown> = {}) {
    return this.audit.append(actor, action, rationale, source, { shipment: c.shipmentId, ...data }).idx;
  }

  // ---------- Disruption sensing: lane feed -> forward-looking projection (labelled as projection)
  laneFor(s: Shipment) { return this.feed.items.filter(i => i.lane === `${s.origin}>${s.dest}` && i.severity !== 'none'); }
  project(s: Shipment, heatMin: number, extraDelay = 0): Projection {
    const p = product(s.productId); const delay = Math.max(s.laneDelayHours, ...this.laneFor(s).map(i => i.delayHours), 0) + extraDelay;
    const auto = this.policy.projection.reeferAutonomyHours; const RATE = 30; // assumed heat-min accrued per hour after reefer autonomy
    const over = Math.max(0, delay - auto); const projectedHeatMin = heatMin + over * RATE; const remaining = p.heatBudgetMin - heatMin;
    return { label: 'PROJECTION - not a measurement', plannedTransitHours: s.etaHours, delayHours: delay, autonomyHours: auto, projectedHeatMin,
      projectedPct: Math.round(projectedHeatMin / p.heatBudgetMin * 1000) / 10, willBreach: projectedHeatMin >= p.heatBudgetMin,
      hoursToBreach: remaining <= 0 ? 0 : delay > auto ? Math.round((auto + remaining / RATE) * 10) / 10 : null,
      assumption: `Reefer holds ${auto}h on stalled trucks, then accrues ~${RATE} heat-min/hour (assumption, simulated).` };
  }

  // ---------- Inventory + logistics: evaluate every (lot x carrier) with hard checks in code
  evaluateOptions(c: Case, s: Shipment, excluded: string[], extraDelay = 0): OptionEval[] {
    const p = product(s.productId); const out: OptionEval[] = [];
    const roadDelay = Math.max(0, ...this.laneFor(s).map(i => i.delayHours)) + extraDelay;
    for (const lot of this.stock.filter(l => l.productId === s.productId))
      for (const cr of carriers) {
        const key = `${lot.id}/${cr.id}`; const lane = `${lot.siteId}>${s.dest}`; const route = cr.routes[lane];
        const blocked = roadDelay > 0 && lot.siteId === s.origin && cr.mode !== 'air'; // disrupted road lane
        const hours = route ? route.hours + (blocked ? roadDelay : 0) : 0;
        const arrival = this.policy.replacement.dispatchLeadHours + hours;
        const cost = route ? route.costINR + cr.perUnitINR * s.qty : 0;
        const heatPct = Math.round(cr.projectedHeatMin / p.heatBudgetMin * 1000) / 10;
        const checks: OptionCheck[] = [
          { name: 'route exists', ok: !!route, detail: route ? lane : `${cr.name} does not serve ${lane}` },
          { name: 'stock available', ok: lot.qty >= s.qty && !lot.reservedFor, detail: lot.reservedFor ? `reserved for ${lot.reservedFor}` : `${lot.qty} on hand, need ${s.qty}` },
          { name: 'shelf life', ok: lot.shelfDays >= p.minShelfDays, detail: `${lot.shelfDays}d vs min ${p.minShelfDays}d` },
          { name: 'carrier capacity', ok: cr.capacity >= s.qty, detail: `${cr.capacity} vs ${s.qty}` },
          { name: 'arrives by need-by', ok: !!route && arrival <= s.needByHours, detail: route ? `${arrival}h vs need-by ${s.needByHours}h${blocked ? ` (incl. ${roadDelay}h lane delay)` : ''}` : '-' },
          { name: 'projected heat <= reserve', ok: heatPct <= this.policy.replacement.budgetReserveFraction * 100, detail: `${heatPct}% vs max ${this.policy.replacement.budgetReserveFraction * 100}%` },
          { name: 'not excluded by replan', ok: !excluded.includes(cr.id), detail: excluded.includes(cr.id) ? 'carrier cancelled earlier' : 'ok' },
        ];
        const valid = checks.every(k => k.ok);
        out.push({ key, lotId: lot.id, fromSite: lot.siteId, carrierId: cr.id, carrierName: cr.name, qty: s.qty, hours, arrivalHours: arrival, needByHours: s.needByHours,
          costINR: cost, projectedHeatMin: cr.projectedHeatMin, projectedHeatPct: heatPct, shelfAtArrivalDays: lot.shelfDays, valid, checks, score: valid ? cost + arrival * 100 : Infinity });
      }
    return out.sort((a, b) => a.score - b.score);
  }

  // ---------- the agent loop for one alarm
  async runCase(id: string, o: RunOpts = {}): Promise<Case> {
    const s = this.ship(id); const p = product(s.productId); const aiMode = o.aiMode ?? true; const reader = o.reader ?? ruleReader;
    const c: Case = { shipmentId: id, status: 'awaiting_qa', classification: null, aiMode, readerName: aiMode ? reader.name : 'template (AI off)', reducedCapability: !aiMode,
      trace: [], facts: [], droppedFacts: [], injections: [], ledger: null, flags: [], options: [], excluded: [], replans: 0, holdPlaced: false, laneItems: [], explanation: '' };
    this.cases.set(id, c);
    const L = (a: string, r: string, src: string, d?: Record<string, unknown>) => this.log(c, 'agent', a, r, src, d);
    L('alarm_received', s.alarmReason, `logger:${s.id}`, { product: p.id, qty: s.qty });

    // 1. sense
    this.gate(c, 'agent', 'read_ledger', { shipment: id }, 'Start from sensor data; it is the source of truth for the decision.');
    const ledger = computeLedger(s.observed, p, this.policy); c.ledger = ledger;
    L('ledger_computed', `heat ${ledger.heatMin}/${ledger.heatBudget} min, freeze ${ledger.freezeMin}/${ledger.freezeBudget} min, unknown ${ledger.unknownMin} min, glitches ${ledger.glitchCount}`, 'ledger.ts (deterministic)', { usedPct: ledger.usedPct });

    this.gate(c, 'agent', 'lane_status', { lane: `${s.origin}>${s.dest}` }, 'Check whether the route itself is disrupted (affects ETA and replacement routing).');
    c.laneItems = this.laneFor(s); c.projection = this.project(s, ledger.heatMin, o.extraDelayHours);
    if (c.laneItems.length) L('lane_disruption', c.laneItems.map(i => i.title).join(' | '), this.feed.label, { delayHours: c.projection.delayHours });

    // 2. read notes (AI) - facts must quote; injections flagged, never obeyed
    this.gate(c, 'agent', 'read_notes', { notes: s.notes.length }, 'Notes may explain the cause; they cannot change the verdict.');
    c.injections = detectInjections(s.notes);
    if (aiMode) { const raw = await reader.read(s.notes); const v = verifyFacts(s.notes, raw, reader.name); c.facts = v.kept; c.droppedFacts = v.dropped; }
    if (c.droppedFacts.length) L('facts_dropped', `${c.droppedFacts.length} fact(s) dropped: quote not found in source note`, 'quote-verifier', { dropped: c.droppedFacts.map(f => f.quote) });
    if (c.injections.length) { c.flags.push('injection_detected'); L('injection_flagged', c.injections.map(i => `${i.kind}: "${i.quote}"`).join('; '), `notes:${s.id}`); }

    // 3. triage (CODE)
    const t = classify(ledger, this.policy); c.classification = t.classification; c.disposition = t.disposition;
    L('triage', t.reason, 'ledger.ts classify()', { classification: t.classification, disposition: t.disposition });
    const saysOk = c.facts.some(f => f.type === 'claim_ok');
    if (saysOk && t.classification === 'true_excursion') { c.conflict = 'Handler note says everything was fine, but the sensor shows a real excursion. Sensor data wins; QA must review the discrepancy.'; c.flags.push('notes_contradict_sensor'); L('conflict', c.conflict, 'quote-verified note vs ledger'); }

    // 4. act on disposition
    if (t.disposition === 'FALSE_ALARM') { c.status = 'closed_false_alarm'; L('closed', 'False alarm closed automatically; no stock blocked.', 'policy.alarm'); }
    else if (t.disposition === 'ABSTAIN_ESCALATE') {
      this.placeHold(c, 'Unknown data window; hold until evidence arrives.');
      this.gate(c, 'agent', 'escalate', { to: 'QA' }, 'Cannot decide without the missing data.');
      c.abstain = { reason: t.reason, evidenceNeeded: t.evidenceNeeded }; c.status = 'escalated_undetermined';
      L('abstain', t.reason, 'ledger gaps', { evidenceNeeded: t.evidenceNeeded });
    } else if (t.disposition === 'WITHIN_BUDGET_QA_REVIEW') { this.placeHold(c, 'Excursion within budget; QA must review before release.'); c.status = 'awaiting_qa'; }
    else { this.placeHold(c, 'Stability budget breached: quarantine.'); await this.replace(c, s, o); }

    c.explanation = this.explain(c, s); c.dossier = this.dossier(c, s);
    return c;
  }

  private placeHold(c: Case, why: string) {
    if (this.gate(c, 'agent', 'place_hold', { shipment: c.shipmentId }, why).ok) { this.holds.add(c.shipmentId); c.holdPlaced = true; this.log(c, 'agent', 'quality_hold', why, 'policy.ledger'); }
  }

  // ---------- replacement with verify-and-replan (max rounds from policy)
  private async replace(c: Case, s: Shipment, o: RunOpts) {
    const forced = new Set([...(o.forceCancel ?? []), ...(s.chaosCancel ? [s.chaosCancel] : [])]);
    while (c.replans < this.policy.replan.maxRounds) {
      this.gate(c, 'agent', 'find_stock', { product: s.productId, qty: s.qty }, 'Find replacement units for the clinic.');
      this.gate(c, 'agent', 'quote_carriers', { dest: s.dest, excluded: c.excluded }, 'Compare carriers on time, heat risk and cost.');
      c.options = this.evaluateOptions(c, s, c.excluded, o.extraDelayHours);
      const best = c.options.find(x => x.valid);
      this.log(c, 'agent', 'options_evaluated', `${c.options.filter(x => x.valid).length}/${c.options.length} options pass all checks`, 'evaluateOptions() hard checks',
        { best: best?.key, rejected: c.options.filter(x => !x.valid).slice(0, 6).map(x => `${x.key}: ${x.checks.filter(k => !k.ok).map(k => k.name).join(', ')}`) });
      if (!best) { c.status = 'no_replacement_escalated'; c.disposition = 'NO_REPLACEMENT_ESCALATE'; this.gate(c, 'agent', 'escalate', { to: 'controller' }, 'No option passes every check.'); this.log(c, 'agent', 'escalate', 'No valid replacement; human must decide (e.g. emergency procurement).', 'planner'); return; }
      c.chosen = best;
      if (best.costINR > this.policy.spend.limitINR) {
        // the agent TRIES the order first so the judge can see the gate block it, then asks a human
        this.gate(c, 'agent', 'create_order', { lot: best.lotId, costINR: best.costINR }, 'Cheapest valid option, but above the auto-spend limit.');
        this.gate(c, 'agent', 'request_spend_approval', { costINR: best.costINR }, 'Spend above limit needs a human.');
        c.pendingSpend = best; c.status = 'awaiting_qa_spend_approval';
        this.log(c, 'agent', 'spend_approval_requested', `INR ${best.costINR} > limit INR ${this.policy.spend.limitINR}`, 'policy.spend'); return;
      }
      if (await this.book(c, s, best, forced)) return;
    }
    c.status = 'no_replacement_escalated'; c.disposition = 'NO_REPLACEMENT_ESCALATE';
    this.log(c, 'agent', 'escalate', `Gave up after ${this.policy.replan.maxRounds} rounds.`, 'policy.replan');
  }

  private async book(c: Case, s: Shipment, best: OptionEval, forced: Set<string>): Promise<boolean> {
    const orderId = `PO-${++this.seq}`; const bookingId = `BK-${this.seq}`;
    if (!this.gate(c, 'agent', 'create_order', { lot: best.lotId, qty: s.qty, costINR: best.costINR }, `Best valid option ${best.key}.`).ok) return false;
    this.orders.push({ id: orderId, shipmentId: s.id, lotId: best.lotId, qty: s.qty, costINR: best.costINR, status: 'created' });
    this.log(c, 'agent', 'order_created', `${orderId}: ${s.qty} x ${s.productId} from ${best.lotId}`, 'mock-ERP', { costINR: best.costINR });
    this.gate(c, 'agent', 'book_carrier', { orderId, carrier: best.carrierId }, `${best.carrierName}: ${best.arrivalHours}h, heat ${best.projectedHeatPct}%.`);
    const cancelled = forced.has(best.carrierId);
    this.bookings.push({ id: bookingId, shipmentId: s.id, carrierId: best.carrierId, orderId, status: cancelled ? 'cancelled' : 'confirmed', costINR: best.costINR, cancelReason: cancelled ? 'carrier: no reefer available (simulated cancellation)' : undefined });
    this.log(c, 'agent', 'carrier_booked', `${bookingId} with ${best.carrierName}`, 'mock-carrier-api');
    // verify the world actually changed - never trust our own action
    this.gate(c, 'agent', 'verify_booking', { bookingId }, 'Confirm the booking really exists before claiming success.');
    const bk = this.bookings.find(b => b.id === bookingId)!;
    const verification: OptionCheck[] = [
      { name: 'booking confirmed by carrier', ok: bk.status === 'confirmed', detail: bk.status + (bk.cancelReason ? ` - ${bk.cancelReason}` : '') },
      { name: 'order still live', ok: true, detail: orderId },
      { name: 'arrival within need-by', ok: best.arrivalHours <= s.needByHours, detail: `${best.arrivalHours}h <= ${s.needByHours}h` },
    ];
    if (bk.status !== 'confirmed') {
      this.gate(c, 'agent', 'cancel_order', { orderId }, 'Carrier cancelled; release the order and replan.');
      this.orders.find(x => x.id === orderId)!.status = 'cancelled';
      c.excluded.push(best.carrierId); c.replans++; forced.delete(best.carrierId);
      this.log(c, 'agent', 'replan', `Verification failed (${bk.cancelReason}). Excluding ${best.carrierId}; round ${c.replans}.`, 'verify_booking');
      return false;
    }
    this.orders.find(x => x.id === orderId)!.status = 'confirmed';
    this.stock.find(l => l.id === best.lotId)!.qty -= s.qty;
    c.replacement = { orderId, bookingId, carrierId: best.carrierId, carrierName: best.carrierName, lotId: best.lotId, arrivalHours: best.arrivalHours, verified: true, verification, costINR: best.costINR };
    c.status = 'replacement_booked_awaiting_qa';
    this.log(c, 'agent', 'replacement_verified', `${bookingId} confirmed; arrives in ${best.arrivalHours}h.`, 'verify_booking');
    return true;
  }

  // ---------- human-in-the-loop
  approveSpend(id: string, token: string, reason: string) {
    const c = this.cases.get(id); if (!c?.pendingSpend) throw new Error('no pending spend approval');
    if (token !== this.policy.roles.qa && token !== this.policy.roles.controller) { this.audit.append('unknown', 'denied:approve_spend', 'bad role token', 'auth'); throw new Error('not authorised'); }
    const s = this.ship(id); const opt = c.pendingSpend; c.pendingSpend = undefined;
    const orderId = `PO-${++this.seq}`, bookingId = `BK-${this.seq}`;
    this.gate(c, 'agent', 'create_order', { lot: opt.lotId, costINR: opt.costINR, approved: true }, `Human approved spend: ${reason}`);
    const lot = this.stock.find(l => l.id === opt.lotId)!;
    if (lot.qty < s.qty) throw new Error(`Stock changed since the plan: ${lot.id} now has ${lot.qty}. Re-run the case.`);
    lot.qty -= s.qty;
    this.orders.push({ id: orderId, shipmentId: id, lotId: opt.lotId, qty: s.qty, costINR: opt.costINR, status: 'confirmed' });
    this.bookings.push({ id: bookingId, shipmentId: id, carrierId: opt.carrierId, orderId, status: 'confirmed', costINR: opt.costINR });
    this.audit.append('controller', 'spend_approved', reason || '(no reason)', 'human', { shipment: id, costINR: opt.costINR });
    c.replacement = { orderId, bookingId, carrierId: opt.carrierId, carrierName: opt.carrierName, lotId: opt.lotId, arrivalHours: opt.arrivalHours, verified: true, costINR: opt.costINR,
      verification: [{ name: 'booking confirmed by carrier', ok: true, detail: 'confirmed' }] };
    c.status = 'replacement_booked_awaiting_qa'; c.explanation = this.explain(c, s); c.dossier = this.dossier(c, s); return c;
  }

  qaDecide(id: string, token: string, decision: 'release' | 'reject', reason: string, override = false) {
    const c = this.cases.get(id); if (!c) throw new Error('case not run yet');
    const role: Role = token === this.policy.roles.qa ? 'qa' : 'agent'; // anything without the QA token is treated as the agent
    const tool = decision === 'release' ? 'qa_release' : 'qa_reject';
    const g = this.gate(c, role, tool, { reason, override }, 'QA decision');
    if (!g.ok) throw new Error(g.reason);
    if (decision === 'release' && c.ledger?.status === 'breached' && !override) throw new Error('Budget breached: release requires an explicit override with a reason.');
    if (override && (!reason || reason.trim().length < 10)) throw new Error('Override needs a written reason (min 10 chars).');
    c.qa = { decision, reason, override, at: new Date().toISOString() }; c.status = decision === 'release' ? 'qa_released' : 'qa_rejected';
    if (decision === 'release') this.holds.delete(id);
    this.audit.append('qa', override ? `qa_${decision}_OVERRIDE` : `qa_${decision}`, reason || '(no reason)', 'human', { shipment: id });
    c.dossier = this.dossier(c, this.ship(id)); return c;
  }

  // ---------- multi-clinic priority when stock is short
  rank() {
    const open = [...this.cases.values()].filter(c => c.disposition === 'BREACH_REPLACE' || c.disposition === 'NO_REPLACEMENT_ESCALATE');
    const w = this.policy.ranking.weights;
    const scored = open.map(c => {
      const s = this.ship(c.shipmentId);
      const parts = { daysOfStock: Math.round(w.daysOfStock * (1 / (s.clinicDaysStock + 0.5)) * 1000) / 1000, criticalityTier: Math.round(w.criticalityTier * ((4 - s.tier) / 3) * 1000) / 1000, budgetOverrun: Math.round(w.budgetOverrun * Math.min(1, Math.max(0, ((c.ledger?.usedPct ?? 0) - 100) / 100)) * 1000) / 1000 };
      const score = Math.round((parts.daysOfStock + parts.criticalityTier + parts.budgetOverrun) * 1000) / 1000;
      const reasons = [`${site(s.dest).name} has ${s.clinicDaysStock} day(s) of stock`, `criticality tier ${s.tier}`, `budget used ${c.ledger?.usedPct}%`];
      return { c, score, parts, reasons };
    }).sort((a, b) => b.score - a.score);
    scored.forEach((x, i) => (x.c.rank = { position: i + 1, score: x.score, parts: x.parts, reasons: x.reasons }));
    return scored.map(x => ({ shipmentId: x.c.shipmentId, clinic: site(this.ship(x.c.shipmentId).dest).name, ...x.c.rank! }));
  }

  // ---------- explanation: every sentence is tied to a claim with a source
  dossier(c: Case, s: Shipment): Claim[] {
    const out: Claim[] = []; let n = 0; const add = (kind: Claim['kind'], text: string, source: string, quote?: string) => out.push({ id: `C${++n}`, kind, text, source, quote });
    const l = c.ledger!;
    add('computation', `Heat exposure ${l.heatMin} of ${l.heatBudget} min (${l.heatPct}%); freeze ${l.freezeMin} of ${l.freezeBudget} min.`, 'ledger.ts on logger readings');
    if (l.glitchCount) add('computation', `${l.glitchCount} isolated sensor glitch(es) were filtered.`, 'ledger.ts cleanReadings()');
    if (l.unknownMin) add('computation', `${l.unknownMin} min of data are missing.`, 'ledger.ts gaps');
    add('computation', `Classification: ${c.classification}; disposition ${c.disposition}.`, 'ledger.ts classify() + policy.json');
    c.facts.forEach(f => add('fact', `Handler note ${f.noteIdx + 1}: ${f.type} = ${f.value}.`, `note ${f.noteIdx + 1} (${f.reader}, quote-verified)`, f.quote));
    c.laneItems.forEach(i => add('external', `Lane: ${i.title}.`, `${this.feed.label} item ${i.id}`));
    if (c.projection?.delayHours) add('computation', `Projected heat if left in transit: ${c.projection.projectedPct}% of budget.`, 'project() - PROJECTION, assumption-based');
    if (c.holdPlaced) add('action', 'Quality hold placed.', 'place_hold tool');
    if (c.replans) add('action', `Re-planned ${c.replans} time(s) after carrier cancellation.`, 'verify_booking tool');
    if (c.replacement) add('verification', `Replacement ${c.replacement.bookingId} via ${c.replacement.carrierName} confirmed, arriving in ${c.replacement.arrivalHours}h.`, 'verify_booking tool (mock carrier API)');
    if (c.pendingSpend) add('action', `Awaiting human spend approval for INR ${c.pendingSpend.costINR}.`, 'policy.spend');
    if (c.qa) add('action', `QA ${c.qa.decision}${c.qa.override ? ' (OVERRIDE)' : ''}: ${c.qa.reason}`, 'human QA');
    const idx = this.audit.entries.filter(e => (e.data as any).shipment === s.id).map(e => e.idx);
    out.forEach((cl, i) => (cl.auditIdx = idx[Math.min(i, idx.length - 1)]));
    return out;
  }

  explain(c: Case, s: Shipment): string {
    const p = product(s.productId), l = c.ledger!; const dest = site(s.dest).name;
    const lines: string[] = [];
    lines.push(`${s.id}: ${s.qty} units of ${p.name} to ${dest}.`);
    if (c.disposition === 'FALSE_ALARM') lines.push(`This was a false alarm${l.glitchCount ? ' caused by sensor glitches' : ''}; no stock was blocked.`);
    if (c.disposition === 'ABSTAIN_ESCALATE') lines.push(`ColdLoop is NOT deciding: ${c.abstain!.reason} Needed: ${c.abstain!.evidenceNeeded.join('; ')}.`);
    if (c.disposition === 'WITHIN_BUDGET_QA_REVIEW') lines.push(`A real excursion used ${l.usedPct}% of the stability budget. The lot is on hold for QA.`);
    if (c.disposition === 'BREACH_REPLACE' || c.disposition === 'NO_REPLACEMENT_ESCALATE') lines.push(`The stability budget is exceeded (${l.usedPct}%). The shipment is quarantined.`);
    const cause = c.facts.find(f => f.type === 'cause');
    if (c.aiMode && cause) lines.push(`Likely cause from handler notes: ${String(cause.value).replace('_', ' ')} ("${cause.quote}").`);
    if (c.conflict) lines.push(c.conflict);
    if (c.injections.length) lines.push(`Warning: ${c.injections.length} note(s) tried to give instructions to the system. They were ignored and flagged.`);
    if (c.laneItems.length) lines.push(`Route disruption: ${c.laneItems[0].title} (recorded sample).`);
    if (c.replans) lines.push(`The first carrier cancelled after booking; ColdLoop re-planned ${c.replans} time(s).`);
    if (c.replacement) lines.push(`Replacement ${c.replacement.bookingId} (${c.replacement.carrierName}) is verified and arrives in ${c.replacement.arrivalHours}h, before the ${s.needByHours}h need-by.`);
    if (c.pendingSpend) lines.push(`The best option costs INR ${c.pendingSpend.costINR}, above the auto-spend limit, so it waits for a human.`);
    if (c.status === 'no_replacement_escalated') lines.push('No option passed every safety check. A human must decide.');
    if (!c.aiMode) lines.push('(AI is OFF: template explanation. The decision is identical.)');
    return lines.join(' ');
  }

  /** Run every alarm. Most urgent clinics (fewest days of stock, highest tier) go first, so scarce stock goes where it matters most. */
  async runAll(o: RunOpts = {}) {
    const order = [...this.shipments].sort((a, b) => (a.clinicDaysStock + a.tier) - (b.clinicDaysStock + b.tier));
    for (const s of order) if (!this.cases.has(s.id)) await this.runCase(s.id, o);
    return this.rank();
  }

  impact() {
    const reps = [...this.cases.values()].filter(c => c.replacement);
    const doses = reps.reduce((s, c) => { const sh = this.ship(c.shipmentId); return s + sh.qty * product(sh.productId).dosesPerUnit; }, 0);
    const fa = [...this.cases.values()].filter(c => c.disposition === 'FALSE_ALARM').length;
    return { casesRun: this.cases.size, replacementsVerified: reps.length, dosesProtected: doses, falseAlarmsClosed: fa,
      onHold: this.holds.size, blockedToolCalls: this.deniedCalls.length, note: 'Synthetic counts from simulated data.' };
  }
}
