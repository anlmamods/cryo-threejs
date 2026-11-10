import { describe, it, expect } from "vitest";
import { SpellLights, SPELL_LIGHT_UNIFORMS } from "../src/spells/spellLights.js";

type U = { value: Float32Array | number };

describe("SpellLights pool cap", () => {
  it("keeps the first four lights and drops the fifth", () => {
    const lights = new SpellLights();
    for (let i = 0; i < 5; i++) {
      lights.add(i, i + 1, i + 2, 10 + i, 1, 0.5, 0.25, 1 + i);
    }
    expect(lights.count).toBe(4);
    // First four kept, in order.
    for (let i = 0; i < 4; i++) {
      expect(lights.pos[i * 4]).toBe(i);
      expect(lights.pos[i * 4 + 3]).toBe(10 + i);
      expect(lights.col[i * 4 + 3]).toBe(1 + i);
    }
    // The 5th light was dropped — the pool arrays hold exactly 4 slots.
    expect(lights.pos).toHaveLength(16);
    expect(lights.col).toHaveLength(16);
  });
});

describe("SpellLights validation", () => {
  it("rejects intensity <= 0", () => {
    const lights = new SpellLights();
    lights.add(0, 0, 0, 5, 1, 1, 1, 0);
    lights.add(0, 0, 0, 5, 1, 1, 1, -1);
    expect(lights.count).toBe(0);
  });

  it("rejects radius <= 0", () => {
    const lights = new SpellLights();
    lights.add(0, 0, 0, 0, 1, 1, 1, 1);
    lights.add(0, 0, 0, -2, 1, 1, 1, 1);
    expect(lights.count).toBe(0);
  });

  it("accepts a valid light after a rejected one", () => {
    const lights = new SpellLights();
    lights.add(0, 0, 0, 5, 1, 1, 1, 0);
    lights.add(1, 2, 3, 4, 0.5, 0.6, 0.7, 2);
    expect(lights.count).toBe(1);
    expect(lights.pos[0]).toBe(1);
    expect(lights.col[3]).toBe(2);
  });

  it("scale multiplies intensity, not the color channels", () => {
    const lights = new SpellLights();
    lights.scale = 2.5;
    lights.add(0, 0, 0, 5, 0.4, 0.5, 0.6, 2);
    expect(lights.col[0]).toBeCloseTo(0.4);
    expect(lights.col[1]).toBeCloseTo(0.5);
    expect(lights.col[2]).toBeCloseTo(0.6);
    expect(lights.col[3]).toBeCloseTo(5);
  });
});

describe("SpellLights.begin", () => {
  it("resets count so a new frame starts empty", () => {
    const lights = new SpellLights();
    lights.add(0, 0, 0, 5, 1, 1, 1, 1);
    lights.add(0, 0, 0, 5, 1, 1, 1, 1);
    expect(lights.count).toBe(2);
    lights.begin();
    expect(lights.count).toBe(0);
    lights.add(7, 8, 9, 1, 1, 1, 1, 1);
    expect(lights.count).toBe(1);
    expect(lights.pos[0]).toBe(7); // overwrote slot 0
  });
});

describe("SpellLights.apply", () => {
  it("points the uniforms at the pool's arrays — zero copy", () => {
    const lights = new SpellLights();
    lights.add(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4);
    const target = {
      uniforms: {
        spellLightPos: { value: new Float32Array(16) },
        spellLightCol: { value: new Float32Array(16) },
        spellLightCount: { value: 99 },
      },
    };
    lights.apply(target);
    expect(target.uniforms.spellLightPos.value).toBe(lights.pos);
    expect(target.uniforms.spellLightCol.value).toBe(lights.col);
    expect(target.uniforms.spellLightCount.value).toBe(1);
  });

  it("creates missing uniform entries", () => {
    const lights = new SpellLights();
    lights.add(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4);
    const target: { uniforms: Record<string, U | undefined> } = { uniforms: {} };
    lights.apply(target);
    expect(target.uniforms.spellLightPos?.value).toBe(lights.pos);
    expect(target.uniforms.spellLightCol?.value).toBe(lights.col);
    expect(target.uniforms.spellLightCount?.value).toBe(1);
    for (const name of SPELL_LIGHT_UNIFORMS) {
      expect(target.uniforms[name]).toBeDefined();
    }
  });

  it("shares one array object between successive applies", () => {
    const lights = new SpellLights();
    const a: { uniforms: Record<string, U | undefined> } = { uniforms: {} };
    const b: { uniforms: Record<string, U | undefined> } = { uniforms: {} };
    lights.apply(a);
    lights.apply(b);
    expect(a.uniforms.spellLightPos?.value).toBe(b.uniforms.spellLightPos?.value);
  });

  it("ignores a null or undefined target", () => {
    const lights = new SpellLights();
    expect(() => lights.apply(null)).not.toThrow();
    expect(() => lights.apply(undefined)).not.toThrow();
    expect(() => lights.apply({ uniforms: undefined } as never)).not.toThrow();
  });
});
