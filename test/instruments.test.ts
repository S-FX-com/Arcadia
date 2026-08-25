// Dormancy flags (§1, §4.3). The rule under test: an absent or non-'on' row
// is DORMANT — a fresh database wakes nothing, and only the literal value
// 'on' wakes an instrument.

import { describe, expect, it } from "vitest";
import { INSTRUMENTS, instrumentEnabled, type Instrument } from "../src/lib/instruments";

function configDb(rows: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    db: {
      prepare(_sql: string) {
        return {
          bind(...values: unknown[]) {
            const key = String(values[0]);
            asked.push(key);
            return {
              async first<T>(): Promise<T | null> {
                return key in rows ? ({ value: rows[key] } as T) : null;
              },
            };
          },
        };
      },
    },
  };
}

describe("instrument dormancy flags", () => {
  const all = Object.keys(INSTRUMENTS) as Instrument[];

  it("covers exactly the three §4.3 instruments", () => {
    expect(all.sort()).toEqual(["certification_ledger", "dispatch_enforcement", "escalation_ladder"]);
  });

  it("is dormant when the row is absent — a fresh database wakes nothing", async () => {
    const { db } = configDb({});
    for (const instrument of all) {
      expect(await instrumentEnabled(db, instrument), instrument).toBe(false);
    }
  });

  it("is dormant on 'off' and anything that is not the literal 'on'", async () => {
    const { db } = configDb({
      "instrument.escalation_ladder": "off",
      "instrument.certification_ledger": "ON",
      "instrument.dispatch_enforcement": "true",
    });
    for (const instrument of all) {
      expect(await instrumentEnabled(db, instrument), instrument).toBe(false);
    }
  });

  it("wakes only the instrument whose row says 'on'", async () => {
    const { db, asked } = configDb({ "instrument.escalation_ladder": "on" });
    expect(await instrumentEnabled(db, "escalation_ladder")).toBe(true);
    expect(await instrumentEnabled(db, "certification_ledger")).toBe(false);
    expect(asked).toEqual(["instrument.escalation_ladder", "instrument.certification_ledger"]);
  });
});
