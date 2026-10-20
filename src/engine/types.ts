export type Role = 'agent' | 'controller' | 'qa';
export type Classification = 'true_excursion' | 'false_alarm' | 'undetermined';
export type Disposition =
  | 'FALSE_ALARM'
  | 'WITHIN_BUDGET_QA_REVIEW'
  | 'BREACH_REPLACE'
  | 'ABSTAIN_ESCALATE'
  | 'NO_REPLACEMENT_ESCALATE';

export interface Reading { t: number; c: number } // t = minutes since dispatch, c = deg C

export interface Product {
  id: string; name: string; kind: string;
  heatBudgetMin: number; freezeBudgetMin: number; minShelfDays: number; dosesPerUnit: number;
  simulated: true;
}
export interface Site { id: string; name: string; type: 'warehouse' | 'depot' | 'clinic' }
export interface StockLot { id: string; productId: string; siteId: string; qty: number; shelfDays: number; reservedFor?: string }
export interface Route { hours: number; costINR: number }
export interface Carrier {
  id: string; name: string; capacity: number; perUnitINR: number; projectedHeatMin: number;
  routes: Record<string, Route>; cancelsAfterBooking: boolean; mock: true; mode?: 'road' | 'air';
}
export interface Shipment {
  id: string; productId: string; qty: number; origin: string; dest: string; carrierId: string;
  etaHours: number; needByHours: number; laneDelayHours: number; clinicDaysStock: number; tier: 1 | 2 | 3;
  observed: Reading[]; full?: Reading[]; notes: string[]; handlerReply?: string | null; alarmReason: string; chaosCancel?: string;
}
export interface LaneItem { id: string; ts: string; lane: string; title: string; severity: string; delayHours: number }
export interface LaneFeed { source: 'recorded-sample' | 'live'; label: string; items: LaneItem[] }

export interface Policy {
  alarm: { toleranceMin: number; glitchJumpC: number; maxGapMin: number };
  ledger: { heatAboveC: number; freezeBelowC: number; warnPct: number };
  replacement: { budgetReserveFraction: number; dispatchLeadHours: number };
  spend: { limitINR: number };
  replan: { maxRounds: number };
  ranking: { weights: { daysOfStock: number; criticalityTier: number; budgetOverrun: number } };
  projection: { reeferAutonomyHours: number };
  roles: { qa: string; controller: string };
}

export interface Excursion { kind: 'heat' | 'freeze'; startT: number; endT: number; minutes: number; peak: number }
export interface Gap { fromT: number; toT: number; unknownMin: number }
export interface Ledger {
  heatMin: number; freezeMin: number; heatBudget: number; freezeBudget: number;
  heatPct: number; freezePct: number; usedPct: number; status: 'ok' | 'warn' | 'breached';
  excursions: Excursion[]; gaps: Gap[]; unknownMin: number; glitchCount: number; simulated: true;
}

export interface RawFact { type: 'cause' | 'duration_min' | 'claim_ok'; value: string | number; quote: string }
export interface Fact extends RawFact { id: string; noteIdx: number; reader: string; verified: boolean }
export interface InjectionFlag { noteIdx: number; kind: string; quote: string }

export interface AuditEntry {
  idx: number; ts: string; actor: string; action: string; rationale: string; source: string;
  data: Record<string, unknown>; prevHash: string; hash: string;
}

export interface TraceStep { n: number; ts: string; tool: string; args: string; why: string; result: string; allowed: boolean }

export interface OptionCheck { name: string; ok: boolean; detail: string }
export interface OptionEval {
  key: string; lotId: string; fromSite: string; carrierId: string; carrierName: string;
  qty: number; hours: number; arrivalHours: number; needByHours: number; costINR: number;
  projectedHeatMin: number; projectedHeatPct: number; shelfAtArrivalDays: number;
  valid: boolean; checks: OptionCheck[]; score: number;
}

export interface Claim {
  id: string; kind: 'fact' | 'computation' | 'external' | 'action' | 'verification';
  text: string; source: string; quote?: string; auditIdx?: number;
}

export type CaseStatus =
  | 'closed_false_alarm' | 'awaiting_qa' | 'escalated_undetermined' | 'replacement_booked_awaiting_qa'
  | 'awaiting_qa_spend_approval' | 'no_replacement_escalated' | 'qa_released' | 'qa_rejected';

export interface Case {
  shipmentId: string; status: CaseStatus; classification: Classification | null;
  aiMode: boolean; readerName: string; reducedCapability: boolean;
  trace: TraceStep[]; facts: Fact[]; droppedFacts: Fact[]; injections: InjectionFlag[];
  ledger: Ledger | null; flags: string[];
  abstain?: { reason: string; evidenceNeeded: string[] };
  conflict?: string; conflictResolved?: boolean;
  options: OptionEval[]; chosen?: OptionEval; excluded: string[]; replans: number;
  replacement?: { orderId: string; bookingId: string; carrierId: string; carrierName: string; lotId: string; arrivalHours: number; verified: boolean; verification: OptionCheck[]; costINR: number };
  pendingSpend?: OptionEval;
  holdPlaced: boolean; rank?: { position: number; score: number; parts: Record<string, number>; reasons: string[] };
  laneItems: LaneItem[]; projection?: Projection; explanation: string; dossier?: Claim[];
  qa?: { decision: 'release' | 'reject'; reason: string; override: boolean; at: string };
  disposition?: Disposition;
}

export interface Projection {
  label: string; plannedTransitHours: number; delayHours: number; autonomyHours: number;
  projectedHeatMin: number; projectedPct: number; willBreach: boolean; hoursToBreach: number | null; assumption: string;
}

export interface Booking { id: string; shipmentId: string; carrierId: string; orderId: string; status: 'confirmed' | 'cancelled'; costINR: number; cancelReason?: string }
export interface Order { id: string; shipmentId: string; lotId: string; qty: number; costINR: number; status: 'created' | 'cancelled' | 'confirmed' }
