// Tamper-evident, hash-chained audit log (Compliance & Audit agent's record).
import { createHash } from 'node:crypto';
import type { AuditEntry } from './types.js';

const GENESIS = '0'.repeat(64);
const h = (e: Omit<AuditEntry, 'hash'>) => createHash('sha256').update(JSON.stringify([e.idx, e.ts, e.actor, e.action, e.rationale, e.source, e.data, e.prevHash])).digest('hex');

export class AuditLog {
  entries: AuditEntry[] = [];
  private clock = Date.parse('2026-11-04T02:00:00+05:30');
  append(actor: string, action: string, rationale: string, source: string, data: Record<string, unknown> = {}) {
    const prevHash = this.entries.at(-1)?.hash ?? GENESIS;
    this.clock += 7000;
    const base = { idx: this.entries.length, ts: new Date(this.clock).toISOString(), actor, action, rationale, source, data, prevHash };
    const e = { ...base, hash: h(base) }; this.entries.push(e); return e;
  }
  verify(): { ok: boolean; brokenAt: number | null } {
    let prev = GENESIS;
    for (const e of this.entries) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || h(rest) !== hash) return { ok: false, brokenAt: e.idx };
      prev = hash;
    }
    return { ok: true, brokenAt: null };
  }
  /** Demo only: silently edit one record to show the chain catches it. */
  tamper(idx: number) { const e = this.entries[idx]; if (e) e.rationale = e.rationale + ' [EDITED AFTER THE FACT]'; }
}
