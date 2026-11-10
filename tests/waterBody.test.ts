import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import {
  WaterBody,
  STRAND_COLS,
  PROFILE_TUBE,
  PROFILE_SHEET,
} from "../src/spells/waterBody.js";
import { SpellLights } from "../src/spells/spellLights.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

// Pool size — module-private in waterBody.ts (`STRAND_MAX`); matches
// `vec4 strandParams[8]` in the shader.
const STRAND_MAX = 8;

const STRAND_MIN_COLS = 2;
const FLOATS_PER_STRAND = STRAND_COLS * 3 * 4;
const ROW_STRIDE = STRAND_COLS * 4;

function makeGfx() {
  const added: Array<{ mesh: THREE.Mesh; layer: number; order: number }> = [];
  return {
    added,
    gfx: {
      addMesh(mesh: THREE.Mesh, layer: number, order: number) {
        added.push({ mesh, layer, order });
      },
      LAYER: { OPAQUE: 1, BLEND: 2 },
      blackTex: new THREE.Texture(),
      whiteTex: new THREE.Texture(),
    },
  };
}

function makeWater() {
  const { gfx, added } = makeGfx();
  const lights = new SpellLights();
  const water = new WaterBody(gfx as never, null, null, lights, null);
  return { water, added, lights };
}

const cam = () => new THREE.Vector3(0, 10, 0);

let savedShowSpells: boolean;

beforeAll(() => {
  registerShaders();
});

beforeEach(() => {
  savedShowSpells = S.showSpells as boolean;
  S.showSpells = true;
});

afterEach(() => {
  S.showSpells = savedShowSpells;
});

describe("WaterBody construction", () => {
  it("registers its mesh blended and starts hidden", () => {
    const { water, added } = makeWater();
    expect(added).toHaveLength(1);
    expect(added[0].mesh).toBe(water.mesh);
    expect(added[0].layer).toBe(2); // gfx.LAYER.BLEND
    expect(water.mesh.visible).toBe(false);
    expect(water._live).toBe(0);
    expect(water._used.every((u) => u === false)).toBe(true);
  });
});

describe("WaterBody.acquire / release", () => {
  it("hands out distinct slots and returns -1 when the pool is exhausted", () => {
    const { water } = makeWater();
    const slots: number[] = [];
    for (let i = 0; i < STRAND_MAX; i++) slots.push(water.acquire());
    expect(new Set(slots).size).toBe(STRAND_MAX);
    for (const s of slots) expect(s).toBeGreaterThanOrEqual(0);
    expect(water.acquire()).toBe(-1);
  });

  it("release round trip re-enables exactly the released slot", () => {
    const { water } = makeWater();
    const slots: number[] = [];
    for (let i = 0; i < STRAND_MAX; i++) slots.push(water.acquire());
    expect(water.acquire()).toBe(-1);
    water.release(3);
    expect(water.acquire()).toBe(3);
    expect(water.acquire()).toBe(-1);
  });

  it("release ignores out-of-range indices", () => {
    const { water } = makeWater();
    const slots: number[] = [];
    for (let i = 0; i < STRAND_MAX; i++) slots.push(water.acquire());
    water.release(-1);
    water.release(STRAND_MAX);
    water.release(999);
    // Nothing was freed by the invalid calls.
    expect(water.acquire()).toBe(-1);
    // And a valid release still works afterwards.
    water.release(0);
    expect(water.acquire()).toBe(0);
  });

  it("acquire clears the slot it hands out", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.column(s, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    water.setParams(s, PROFILE_TUBE, 0.5, 1, 10);
    water.release(s);
    const s2 = water.acquire();
    expect(s2).toBe(s);
    const base = s * FLOATS_PER_STRAND;
    for (let i = 0; i < FLOATS_PER_STRAND; i++) {
      expect(water._texData[base + i]).toBe(0);
    }
    expect(water._params[s * 4]).toBe(0);
    expect(water._params[s * 4 + 1]).toBe(0);
    expect(water._params[s * 4 + 2]).toBe(0);
    expect(water._params[s * 4 + 3]).toBe(0);
  });
});

describe("WaterBody.clear", () => {
  it("zeroes the strand's three texture rows and its params", () => {
    const { water } = makeWater();
    const s = water.acquire();
    for (let c = 0; c < STRAND_COLS; c++) {
      water.column(s, c, c, c + 1, c + 2, c + 3, c + 4, c + 5, c + 6, c + 7, c + 8, c + 9, c + 10, c + 11);
    }
    water.setParams(s, PROFILE_SHEET, 0.9, 0.8, STRAND_COLS);
    water.clear(s);
    const base = s * FLOATS_PER_STRAND;
    for (let i = 0; i < FLOATS_PER_STRAND; i++) {
      expect(water._texData[base + i]).toBe(0);
    }
    expect(water._params[s * 4]).toBe(0);
    expect(water._params[s * 4 + 1]).toBe(0);
    expect(water._params[s * 4 + 2]).toBe(0);
    expect(water._params[s * 4 + 3]).toBe(0);
  });

  it("leaves other strands untouched", () => {
    const { water } = makeWater();
    const a = water.acquire();
    const b = water.acquire();
    water.setParams(a, PROFILE_TUBE, 0.5, 0.7, 10);
    water.setParams(b, PROFILE_SHEET, 0.6, 0.8, 12);
    water.column(b, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
    water.clear(a);
    expect(water._params[b * 4 + 2]).toBeCloseTo(0.8, 6);
    expect(water._params[b * 4 + 3]).toBe(12);
    const row = b * 3 * ROW_STRIDE + 3 * 4;
    expect(water._texData[row]).toBe(1);
  });
});

describe("WaterBody.setParams", () => {
  it("treats count below the minimum as 0 — degenerate strand", () => {
    const { water } = makeWater();
    const s = water.acquire();
    for (const count of [0, 1, -3]) {
      water.setParams(s, PROFILE_TUBE, 0.5, 1, count);
      expect(water._params[s * 4 + 3]).toBe(0);
    }
  });

  it("accepts exactly the minimum column count", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 1, STRAND_MIN_COLS);
    expect(water._params[s * 4 + 3]).toBe(STRAND_MIN_COLS);
  });

  it("caps column count at STRAND_COLS", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 1, STRAND_COLS + 100);
    expect(water._params[s * 4 + 3]).toBe(STRAND_COLS);
    water.setParams(s, PROFILE_TUBE, 0.5, 1, STRAND_COLS);
    expect(water._params[s * 4 + 3]).toBe(STRAND_COLS);
  });

  it("stores profile, milkiness and alpha verbatim", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_SHEET, 0.25, 0.75, 16);
    expect(water._params[s * 4]).toBe(PROFILE_SHEET);
    expect(water._params[s * 4 + 1]).toBe(0.25);
    expect(water._params[s * 4 + 2]).toBe(0.75);
    expect(water._params[s * 4 + 3]).toBe(16);
  });
});

describe("WaterBody.column", () => {
  it("writes the three ring rows at the right strides", () => {
    const { water } = makeWater();
    const s = water.acquire();
    const c = 5;
    water.column(s, c, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33);
    const strandBase = s * 3 * ROW_STRIDE;
    // Row 0: (x, y, z, radius)
    expect([...water._texData.slice(strandBase + c * 4, strandBase + c * 4 + 4)])
      .toEqual([10, 11, 12, 13]);
    // Row 1: (rx, ry, rz, twist)
    const row1 = strandBase + ROW_STRIDE + c * 4;
    expect([...water._texData.slice(row1, row1 + 4)]).toEqual([20, 21, 22, 23]);
    // Row 2: (dist, age, foam, flatten)
    const row2 = strandBase + 2 * ROW_STRIDE + c * 4;
    expect([...water._texData.slice(row2, row2 + 4)]).toEqual([30, 31, 32, 33]);
  });

  it("keeps strands and columns from bleeding into each other", () => {
    const { water } = makeWater();
    const a = water.acquire();
    const b = water.acquire();
    water.column(a, STRAND_COLS - 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
    water.column(b, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2);
    // First float of b's row 0 must be 2, not a's tail.
    expect(water._texData[b * 3 * ROW_STRIDE]).toBe(2);
    expect(water._texData[a * 3 * ROW_STRIDE + (STRAND_COLS - 1) * 4]).toBe(1);
  });

  it("ignores out-of-range column indices", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.column(s, -1, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9);
    water.column(s, STRAND_COLS, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8);
    expect([...water._texData]).toEqual([...new Float32Array(water._texData.length)]);
  });
});

describe("WaterBody.update", () => {
  it("computes _live from alpha and column count", () => {
    const { water } = makeWater();
    const a = water.acquire();
    const b = water.acquire();
    // Dead: alpha zero.
    water.setParams(a, PROFILE_TUBE, 0.5, 0, 10);
    // Live.
    water.setParams(b, PROFILE_TUBE, 0.5, 0.8, 10);
    water.update(0.016, cam());
    expect(water._live).toBe(1);
    expect(water.mesh.visible).toBe(true);
  });

  it("does not count a strand whose count was clamped to 0", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 1, 1); // below STRAND_MIN_COLS
    water.update(0.016, cam());
    expect(water._live).toBe(0);
    expect(water.mesh.visible).toBe(false);
  });

  it("does not count a strand below the alpha epsilon", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 0.001, 10); // <= STRAND_ALIVE_EPS
    water.update(0.016, cam());
    expect(water._live).toBe(0);
    expect(water.mesh.visible).toBe(false);
  });

  it("hides the mesh when nothing is live even if showSpells is true", () => {
    const { water } = makeWater();
    water.update(0.016, cam());
    expect(water._live).toBe(0);
    expect(water.mesh.visible).toBe(false);
  });

  it("hides the mesh when showSpells is false even with a live strand", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 1, 10);
    S.showSpells = false;
    water.update(0.016, cam());
    expect(water._live).toBe(1); // still tracked, just not drawn
    expect(water.mesh.visible).toBe(false);
    S.showSpells = true;
    water.update(0.016, cam());
    expect(water.mesh.visible).toBe(true);
  });

  it("release drops the strand out of the live count on the next update", () => {
    const { water } = makeWater();
    const s = water.acquire();
    water.setParams(s, PROFILE_TUBE, 0.5, 1, 10);
    water.update(0.016, cam());
    expect(water._live).toBe(1);
    water.release(s);
    water.update(0.016, cam());
    expect(water._live).toBe(0);
    expect(water.mesh.visible).toBe(false);
  });
});
