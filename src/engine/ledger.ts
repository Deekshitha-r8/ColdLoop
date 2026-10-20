// Deterministic stability ledger. CODE decides; no AI involved.
import type { Ledger, Policy, Product, Reading, Excursion, Gap, Classification, Disposition } from './types.js';

export function cleanReadings(rs: Reading[], p: Policy) {
  let glitchCount = 0;
  const out = rs.filter((r, i) => {
    const prev = rs[i - 1], next = rs[i + 1];
    if (prev && next && Math.abs(r.c - prev.c) > p.alarm.glitchJumpC && Math.abs(r.c - next.c) > p.alarm.glitchJumpC) { glitchCount++; return false; }
    return true;
  });
  return { out, glitchCount };
}

export function computeLedger(rs: Reading[], prod: Product, p: Policy): Ledger {
  const { out, glitchCount } = cleanReadings(rs, p);
  let heatMin = 0, freezeMin = 0; const excursions: Excursion[] = []; const gaps: Gap[] = [];
  let cur: Excursion | null = null;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i]; const dt = b.t - a.t;
    if (dt > p.alarm.maxGapMin) { gaps.push({ fromT: a.t, toT: b.t, unknownMin: dt }); cur = null; continue; }
    const kind = b.c > p.ledger.heatAboveC ? 'heat' : b.c < p.ledger.freezeBelowC ? 'freeze' : null;
    if (kind === 'heat') heatMin += dt; if (kind === 'freeze') freezeMin += dt;
    if (kind) {
      if (cur && cur.kind === kind) { cur.endT = b.t; cur.minutes += dt; cur.peak = kind === 'heat' ? Math.max(cur.peak, b.c) : Math.min(cur.peak, b.c); }
      else { cur = { kind, startT: a.t, endT: b.t, minutes: dt, peak: b.c }; excursions.push(cur); }
    } else cur = null;
  }
  const heatPct = Math.round((heatMin / prod.heatBudgetMin) * 1000) / 10;
  const freezePct = Math.round((freezeMin / prod.freezeBudgetMin) * 1000) / 10;
  const usedPct = Math.max(heatPct, freezePct);
  const unknownMin = gaps.reduce((s, g) => s + g.unknownMin, 0);
  return { heatMin, freezeMin, heatBudget: prod.heatBudgetMin, freezeBudget: prod.freezeBudgetMin, heatPct, freezePct, usedPct,
    status: usedPct >= 100 ? 'breached' : usedPct >= p.ledger.warnPct ? 'warn' : 'ok', excursions, gaps, unknownMin, glitchCount, simulated: true };
}

/** Triage: classify the alarm. Pure function of sensor data + policy. */
export function classify(l: Ledger, p: Policy): { classification: Classification; disposition: Disposition; reason: string; evidenceNeeded: string[] } {
  const worstHeat = l.heatMin + l.unknownMin, worstFreeze = l.freezeMin + l.unknownMin;
  const unknownCouldBreach = l.unknownMin > 0 && l.usedPct < 100 && (worstHeat >= l.heatBudget || worstFreeze >= l.freezeBudget);
  if (unknownCouldBreach) return { classification: 'undetermined', disposition: 'ABSTAIN_ESCALATE',
    reason: `${l.unknownMin} min of logger data missing; worst case could exceed the budget, so the system will not guess.`,
    evidenceNeeded: ['Download the full logger file from the device', 'Handler statement on unit status during the gap', 'Reefer unit power log for the gap window'] };
  const total = l.heatMin + l.freezeMin;
  if (l.usedPct >= 100) return { classification: 'true_excursion', disposition: 'BREACH_REPLACE', reason: `Stability budget used ${l.usedPct}% (>=100%).`, evidenceNeeded: [] };
  if (total < p.alarm.toleranceMin) return { classification: 'false_alarm', disposition: 'FALSE_ALARM',
    reason: l.glitchCount ? `${l.glitchCount} isolated sensor glitch(es) filtered; real out-of-range time ${total} min < ${p.alarm.toleranceMin} min tolerance.` : `Out-of-range time ${total} min is below the ${p.alarm.toleranceMin} min tolerance.`, evidenceNeeded: [] };
  return { classification: 'true_excursion', disposition: 'WITHIN_BUDGET_QA_REVIEW', reason: `Real excursion, budget used ${l.usedPct}% (<100%). Hold for QA.`, evidenceNeeded: [] };
}
