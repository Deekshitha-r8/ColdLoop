// Scenario Planning agent: "what if" runs on a throwaway copy of the world. No side effects on the live state.
import { World } from './world.js';
import type { Policy } from './types.js';

export interface WhatIf { shipmentId: string; extraDelayHours?: number; cancelCarriers?: string[]; spendLimitINR?: number; heatBudgetReserve?: number }

export async function whatIf(live: World, q: WhatIf) {
  const summarise = (w: World, id: string) => {
    const c = w.cases.get(id)!;
    return { disposition: c.disposition, status: c.status, chosen: c.replacement?.carrierName ?? c.pendingSpend?.carrierName ?? null,
      costINR: c.replacement?.costINR ?? c.pendingSpend?.costINR ?? null, arrivalHours: c.replacement?.arrivalHours ?? c.pendingSpend?.arrivalHours ?? null,
      replans: c.replans, validOptions: c.options.filter(o => o.valid).length, projection: c.projection };
  };
  const base = new World(live.policy); await base.runCase(q.shipmentId);
  const pol: Policy = structuredClone(live.policy);
  if (q.spendLimitINR != null) pol.spend.limitINR = q.spendLimitINR;
  if (q.heatBudgetReserve != null) pol.replacement.budgetReserveFraction = q.heatBudgetReserve;
  const alt = new World(pol); await alt.runCase(q.shipmentId, { extraDelayHours: q.extraDelayHours ?? 0, forceCancel: q.cancelCarriers ?? [] });
  return { label: 'WHAT-IF SIMULATION - nothing was booked', inputs: q, baseline: summarise(base, q.shipmentId), scenario: summarise(alt, q.shipmentId) };
}
