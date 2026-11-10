import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUDIO_MANIFEST } from "../src/audio/manifest.js";

const BUSES: Record<string, true> = { ambience: true, music: true, sfx: true, voice: true };

// PlayOpts (src/audio/engine.ts): { gain?, rate?, delay?, bus?, minGap?, exclusive? }
// — every field optional; the manifest must satisfy the same types for the
// fields it shares with PlayOpts, because engine.play reads them off the entry.
describe("AUDIO_MANIFEST data integrity", () => {
  const entries = Object.entries(AUDIO_MANIFEST) as Array<[string, Record<string, unknown>]>;

  it("is non-empty", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty url, a known bus, finite gain, boolean loop", () => {
    for (const [key, entry] of entries) {
      expect(typeof entry.url, `${key}.url`).toBe("string");
      expect((entry.url as string).length, `${key}.url`).toBeGreaterThan(0);
      expect(BUSES[entry.bus as string] === true, `${key}.bus=${String(entry.bus)}`).toBe(true);
      expect(typeof entry.gain, `${key}.gain`).toBe("number");
      expect(Number.isFinite(entry.gain as number), `${key}.gain finite`).toBe(true);
      if ("loop" in entry) expect(typeof entry.loop, `${key}.loop`).toBe("boolean");
    }
  });

  it("every url exists under public/", () => {
    for (const [key, entry] of entries) {
      const p = fileURLToPath(new URL(`../public/${entry.url}`, import.meta.url));
      expect(existsSync(p), `${key}: missing public/${String(entry.url)}`).toBe(true);
    }
  });

  it("fields shared with PlayOpts are valid PlayOpts values", () => {
    for (const [key, entry] of entries) {
      if (entry.gain !== undefined) {
        expect(Number.isFinite(entry.gain), `${key}.gain`).toBe(true);
        expect(entry.gain as number, `${key}.gain >= 0`).toBeGreaterThanOrEqual(0);
      }
      if (entry.rate !== undefined) {
        expect(Number.isFinite(entry.rate), `${key}.rate`).toBe(true);
        expect(entry.rate as number, `${key}.rate > 0`).toBeGreaterThan(0);
      }
      if (entry.bus !== undefined) {
        expect(BUSES[entry.bus as string] === true, `${key}.bus`).toBe(true);
      }
      if (entry.minGap !== undefined) {
        expect(Number.isFinite(entry.minGap), `${key}.minGap`).toBe(true);
        expect(entry.minGap as number, `${key}.minGap >= 0`).toBeGreaterThanOrEqual(0);
      }
      if (entry.exclusive !== undefined) {
        const t = typeof entry.exclusive;
        expect(t === "boolean" || t === "string", `${key}.exclusive`).toBe(true);
        if (t === "string") expect((entry.exclusive as string).length, `${key}.exclusive`).toBeGreaterThan(0);
      }
    }
  });

  it("optional numeric fields are finite and non-negative when present", () => {
    for (const [key, entry] of entries) {
      for (const field of ["trim", "crossfade"] as const) {
        if (entry[field] !== undefined) {
          expect(Number.isFinite(entry[field]), `${key}.${field}`).toBe(true);
          expect(entry[field] as number, `${key}.${field} >= 0`).toBeGreaterThanOrEqual(0);
        }
      }
      if (entry.needs !== undefined) expect(typeof entry.needs, `${key}.needs`).toBe("string");
    }
  });
});
