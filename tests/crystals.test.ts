import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { CrystalField } from "../src/spells/crystals.js";
import { SpellLights } from "../src/spells/spellLights.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

const SUBLIME_SECONDS = 6.0;
const MIN_GROW_SECONDS = 0.05;

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

function makeField() {
  const { gfx, added } = makeGfx();
  const lights = new SpellLights();
  const field = new CrystalField(gfx as never, null, null, lights, null);
  return { field, added, lights };
}

const cam = () => new THREE.Vector3(0, 10, 0);

/** CRYSTAL_MAX — module-private; derived from the pool arrays themselves. */
const poolMax = (field: CrystalField) => field.alive.length;
const rowFloats = (field: CrystalField) => poolMax(field) * 4;

function plant(field: CrystalField, x = 1, y = 0, z = 2, growSeconds = 1, life = 10) {
  field.plant(x, y, z, 0.1, 1, 0.05, 0.6, 0.09, growSeconds, life);
}

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

describe("CrystalField construction", () => {
  it("registers its mesh opaque and starts hidden", () => {
    const { field, added } = makeField();
    expect(added).toHaveLength(1);
    expect(added[0].mesh).toBe(field.mesh);
    expect(added[0].layer).toBe(1); // gfx.LAYER.OPAQUE
    expect(field.mesh.visible).toBe(false);
    expect(field.liveCount).toBe(0);
    expect(field._next).toBe(0);
    expect(field._dirty).toBe(true);
  });
});

describe("CrystalField.plant pool", () => {
  it("advances _next and wraps around the pool", () => {
    const { field } = makeField();
    const max = poolMax(field);
    for (let i = 0; i < max; i++) plant(field, i, 0, 0);
    expect(field._next).toBe(0); // wrapped back to the start
    expect([...field.alive].every((a) => a === 1)).toBe(true);
  });

  it("reuses the first free slot at or after _next", () => {
    const { field } = makeField();
    const max = poolMax(field);
    for (let i = 0; i < max; i++) plant(field, i, 0, 0);
    // Full pool, _next back at 0. Free one slot in the middle.
    field.alive[3] = 0;
    plant(field, 777, 0, 0);
    expect(field.alive[3]).toBe(1);
    const w = rowFloats(field);
    expect(field._texData[3 * 4]).toBe(777);
    expect(field._texData[w + 3 * 4]).toBeCloseTo(0.1); // row 1, slot 3: axis x
    expect(field._next).toBe(4);
  });

  it("when the pool is full, plants silently drop instead of evicting", () => {
    const { field } = makeField();
    const max = poolMax(field);
    for (let i = 0; i < max; i++) plant(field, i, 0, 0);
    field.update(0.016, cam());
    const before = Float32Array.from(field._texData);
    const nextBefore = field._next;
    // Pool totally full: this plant must be dropped without touching anything.
    plant(field, 9999, 0, 0, 1, 10);
    expect(Float32Array.from(field._texData)).toEqual(before);
    expect(field._next).toBe(nextBefore);
    // Nobody's slot was overwritten with the marker position.
    expect([...field._texData]).not.toContain(9999);
  });
});

describe("CrystalField._texData row layout", () => {
  it("writes (x,y,z,height) / (axis,radius) / (growth,seed,0,0) rows", () => {
    const { field } = makeField();
    field.plant(11, 12, 13, 0.3, 0.8, 0.5, 0.9, 0.07, 2, 10);
    const w = rowFloats(field);
    // Slot 0 is the first plant.
    expect([...field._texData.slice(0, 4)]).toEqual([11, 12, 13, Math.fround(0.9)]);
    expect([...field._texData.slice(w, w + 4)]).toEqual([
      Math.fround(0.3),
      Math.fround(0.8),
      Math.fround(0.5),
      Math.fround(0.07),
    ]);
    expect(field._texData[2 * w]).toBe(0); // growth starts at nothing
    const seed = field._texData[2 * w + 1];
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(1);
    expect(field._texData[2 * w + 2]).toBe(0);
    expect(field._texData[2 * w + 3]).toBe(0);
  });

  it("clamps growSeconds to a floor so the grow envelope is never degenerate", () => {
    const { field } = makeField();
    plant(field, 0, 0, 0, 0, 10); // growSeconds = 0
    expect(field.grow[0]).toBeCloseTo(MIN_GROW_SECONDS, 7);
  });
});

describe("CrystalField age → grow → sublime", () => {
  it("grows linearly from nothing over growSeconds, then holds at full size", () => {
    const { field } = makeField();
    const w = rowFloats(field);
    plant(field, 0, 0, 0, /* growSeconds */ 2, /* life */ 10);
    field.update(0.5, cam());
    expect(field._texData[2 * w]).toBeCloseTo(0.25, 5);
    field.update(0.5, cam());
    expect(field._texData[2 * w]).toBeCloseTo(0.5, 5);
    field.update(1.0, cam());
    expect(field._texData[2 * w]).toBeCloseTo(1, 5);
    // Past full size, well before life: still full.
    field.update(5.0, cam());
    expect(field._texData[2 * w]).toBeCloseTo(1, 5);
  });

  it("sublimates linearly once past life and clears the crystal after SUBLIME_SECONDS", () => {
    const { field } = makeField();
    const w = rowFloats(field);
    // growSeconds tiny so we reach full size immediately; life = 1s.
    plant(field, 0, 0, 0, 0.05, 1);
    field.update(1.5, cam()); // age = 1.5, t = (1.5 - 1) / 6 = 1/12
    const g = field._texData[2 * w];
    expect(g).toBeCloseTo(1 - 0.5 / SUBLIME_SECONDS, 5);
    expect(field.alive[0]).toBe(1);
    expect(field.liveCount).toBe(1);
  });

  it("clears alive and zeroes the grow row once sublimation completes", () => {
    const { field } = makeField();
    const w = rowFloats(field);
    plant(field, 0, 0, 0, 0.05, 1);
    // age needs to pass life + SUBLIME_SECONDS = 7s.
    field.update(7.5, cam());
    expect(field.alive[0]).toBe(0);
    expect(field._texData[2 * w]).toBe(0);
    expect(field.liveCount).toBe(0);
  });

  it("a sublimated crystal frees its slot for reuse", () => {
    const { field } = makeField();
    const max = poolMax(field);
    for (let i = 0; i < max; i++) plant(field, i, 0, 0, 0.05, 1);
    field.update(7.5, cam()); // everything sublimes away
    expect(field.liveCount).toBe(0);
    plant(field, 4242, 0, 0, 1, 10);
    expect([...field.alive].filter((a) => a === 1)).toHaveLength(1);
    expect([...field._texData]).toContain(4242);
  });
});

describe("CrystalField.liveCount", () => {
  it("tracks the number of alive crystals through updates", () => {
    const { field } = makeField();
    for (let i = 0; i < 5; i++) plant(field, i, 0, 0, 1, 10);
    field.update(0.016, cam());
    expect(field.liveCount).toBe(5);
  });

  it("drops back to zero when nothing is alive", () => {
    const { field } = makeField();
    plant(field, 0, 0, 0, 0.05, 1);
    field.update(0.016, cam());
    expect(field.liveCount).toBe(1);
    field.update(10, cam()); // blow past life + sublime
    expect(field.liveCount).toBe(0);
  });
});

describe("CrystalField._dirty lifecycle", () => {
  it("starts dirty and goes clean after an upload", () => {
    const { field } = makeField();
    expect(field._dirty).toBe(true);
    field.update(0.016, cam()); // nothing alive, but dirty → uploads once
    expect(field._dirty).toBe(false);
  });

  it("plant marks the field dirty again", () => {
    const { field } = makeField();
    field.update(0.016, cam());
    expect(field._dirty).toBe(false);
    plant(field, 0, 0, 0, 1, 10);
    expect(field._dirty).toBe(true);
    field.update(0.016, cam());
    expect(field._dirty).toBe(false);
  });

  it("a completed sublimation still uploads the zeroed grow row", () => {
    const { field } = makeField();
    plant(field, 0, 0, 0, 0.05, 1);
    field.update(0.016, cam());
    const version = field.dataTex.version;
    // Force showSpells off so the mesh stays hidden; the dirty flag set by
    // the sublime completion is the only reason the row reaches the GPU.
    S.showSpells = false;
    field.update(10, cam()); // completes sublimation
    expect(field.alive[0]).toBe(0);
    expect(field.dataTex.version).toBeGreaterThan(version);
  });

  it("a clean update with nothing alive performs no upload", () => {
    const { field } = makeField();
    field.update(0.016, cam()); // drains the initial _dirty
    const version = field.dataTex.version;
    field.update(0.016, cam()); // nothing alive, not dirty → no upload
    expect(field.dataTex.version).toBe(version);
  });
});

describe("CrystalField mesh.visible gating", () => {
  it("shows the mesh only when something is alive and showSpells is on", () => {
    const { field } = makeField();
    // Nothing alive: invisible regardless.
    field.update(0.016, cam());
    expect(field.mesh.visible).toBe(false);
    // Alive, showSpells on: visible.
    plant(field, 0, 0, 0, 1, 10);
    field.update(0.016, cam());
    expect(field.mesh.visible).toBe(true);
    // Alive, showSpells off: hidden again.
    S.showSpells = false;
    field.update(0.016, cam());
    expect(field.mesh.visible).toBe(false);
    // showSpells back on: visible.
    S.showSpells = true;
    field.update(0.016, cam());
    expect(field.mesh.visible).toBe(true);
  });
});
