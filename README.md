# ColdLoop

Agentic recovery for pharma cold-chain excursions. SAP Hackfest 2026, theme: Resilient Supply Chains.

> **All data is synthetic.** Products, stability budgets, clinics, carriers and costs are invented. Nothing here has clinical or regulatory validity.

When a vaccine shipment raises a temperature alarm, ColdLoop works out whether the alarm is real, quarantines anything unsafe, finds and books a replacement, checks that the booking actually exists, and gives QA one explained decision in which every claim has a source.

**The AI reads and explains. Code decides. A human releases product.**

## Run it

```bash
npm install
npm start            # http://localhost:4004
npm run harness      # 43 scenarios x 3 setups: decision must not change
npm run attacks      # 10 planted attacks: all must be blocked
```

Optional: set `ANTHROPIC_API_KEY` so a live LLM reads the handler notes. The same quote verification applies. Without a key, an offline reader runs and the demo works with no network.

## Demo path (about 3 minutes)

1. Open **SH-1001**, the Tumakuru vaccine alarm, and run it. The budget bar breaks its frame at 120.8%.
2. **Evidence** tab: temperature trace, the NH48 lane disruption, and every claim with its source.
3. **Replacement plan** tab: 16 options, each with 7 hard checks. The first carrier cancelled after booking; the agent verified, saw the cancellation and re-planned.
4. **Notes and AI** tab: notes in English and Hindi, each fact highlighted with its exact quote.
5. Click **Let the agent try to release**. The policy gate refuses it.
6. **Run all alarms**, then **Clinic priority**: who gets scarce stock first, and why.
7. Open **SH-1009**: the only option in time costs more than the spend limit, so a human approves it.
8. **What-if**: add 6h of delay and cancel FrostLine, then watch the plan change.
9. **Audit trail**: click *Secretly edit record #3* and the hash chain flags it.
10. **Trust tests**: both suites run live.

## How it maps to the theme's agents

| Theme agent | In ColdLoop | File |
|---|---|---|
| Disruption Sensing | Logger ledger, glitch filter, lane feed, breach projection | `ledger.ts`, `world.ts project()` |
| Scenario Planning | What-if on a throwaway copy of the world | `whatif.ts` |
| Rerouting & Logistics | Lot × carrier evaluation, booking, verify-and-replan (max 3) | `world.ts evaluateOptions() / book()` |
| Inventory Rebalancing | Shelf life, reservations and stock checks; priority allocation across clinics | `world.ts rank() / runAll()` |
| Compliance & Audit | SHA-256 hash-chained log, claim dossier, printable report | `audit.ts`, `/api/cases/:id/report` |
| Human-in-the-loop | QA-only release/reject, override with reason, spend approval | `world.ts qaDecide() / approveSpend()` |

## Safety design

- **Policy gate:** every tool call goes through `gate()`, which checks role, spend limit and state. `qa_release` can only be called with the QA role.
- **Quote verification:** an AI fact survives only if its quote appears word for word in the note.
- **Injection flags:** notes are data. Hidden instructions are flagged and shown, never followed.
- **Sensor beats notes:** if a note says "all fine" and the ledger shows a breach, the conflict is raised to QA.
- **Abstain:** if missing data could hide a breach, the system holds the lot, refuses to guess and lists the evidence it needs.
- **Verify, don't trust:** after booking, the agent re-reads the booking before it claims success.

## What is real, simulated, or not built

| Real (runs here) | Simulated | Not built |
|---|---|---|
| Ledger and triage logic, policy gate, audit hash chain, planner, ranking, what-if, harness, attacks, UI | All data; carrier and ERP APIs (mock); lane feed (recorded sample); breach projection rate (assumption); role tokens (demo strings) | Real SAP BTP/CAP deployment, IBP/TM/Ariba integration, real logger ingestion, real auth, clinical validation |

The `/odata/v4/coldloop/*` endpoints return OData v4-shaped JSON so that a SAP Fiori or CAP front end could consume them. They are **not** a real CAP service. The next step is to port `src/engine` into a CAP service on a BTP trial.

## Layout

```
data/policy.json            all thresholds, limits and ranking weights
data/lane-feed-sample.json  recorded disruption feed
src/engine/                 types, data, ledger, reader, audit, world (agent), whatif
src/harness.ts, attacks.ts  trust suites
src/server.ts               REST + OData-shaped API
public/index.html           single-page console
```
