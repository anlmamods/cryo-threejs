import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { SprayField } from "../src/vfx/particles.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

const CAPACITY = 5120;

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: unknown; order: unknown }> = [];
  return {
    gfx: {
      addMesh(mesh: THREE.Mesh, layer: number, order: number) {
        added.push({ mesh, layer, order });
      },
      LAYER: { OPAQUE: 1, BLEND: 2 },
      blackTex: new THREE.Texture(),
      whiteTex: new THREE.Texture(),
    },
    added,
  };
}

function makeField(terrain: { heightAt(x: number, z: number): number } | null = null) {
  const { gfx, added } = makeGfx();
  const field = new SprayField(gfx as never, terrain, null, null);
  return { field, added };
}

const cam = () => new THREE.Vector3(0, 10, 0);

let savedWind: number;

beforeAll(() => {
  registerShaders();
});

beforeEach(() => {
  savedWind = S.windStrength as number;
  S.windStrength = 0; // isolate drag/gravity from wind drift
});

afterEach(() => {
  S.windStrength = savedWind;
});

describe("SprayField construction", () => {
  it("registers the mesh on the blend layer and starts with no live grains", () => {
    const { field, added } = makeField();
    expect(added.length).toBe(1);
    expect(added[0].layer).toBe(2);
    expect(field.liveCount).toBe(0);
    expect(field._next).toBe(0);
  });
});

describe("SprayField.emit ring", () => {
  it("writes into the slot at _next and advances the cursor", () => {
    const { field } = makeField();
    field.emit(1, 2, 3, 0, 0, 0, 0.1, 10, 0);
    expect(field.pos[0]).toBe(1);
    expect(field.pos[1]).toBe(2);
    expect(field.pos[2]).toBe(3);
    expect(field._next).toBe(1);
    expect(field.liveCount).toBe(0); // liveCount only refreshed by update()
  });

  it("wraps _next around the capacity ring", () => {
    const { field } = makeField();
    field._next = CAPACITY - 1;
    field.emit(1, 0, 0, 0, 0, 0, 0.1, 10, 0);
    expect(field._next).toBe(0);
    field.emit(2, 0, 0, 0, 0, 0, 0.1, 10, 0);
    expect(field._next).toBe(1);
    expect(field.pos[(CAPACITY - 1) * 3]).toBe(1);
    expect(field.pos[0]).toBe(2);
  });

  it("skips a live slot instead of overwriting it", () => {
    const { field } = makeField();
    field.emit(9, 9, 9, 0, 0, 0, 0.1, 100, 0); // slot 0, live
    field._next = 0; // force the cursor back onto the live slot
    field.emit(5, 5, 5, 0, 0, 0, 0.1, 100, 0);
    expect(field.pos[0]).toBe(9); // live grain untouched
    expect(field.pos[3]).toBe(5); // second grain landed in slot 1
    expect(field._next).toBe(2);
  });

  it("drops the emission when the pool is full", () => {
    const { field } = makeField();
    for (let n = 0; n < CAPACITY; n++) field.emit(n, 100, 0, 0, 0, 0, 0.1, 1000, 0);
    expect(field._next).toBe(0); // wrapped all the way around
    field.emit(999999, 100, 0, 0, 0, 0, 0.1, 1000, 0); // must be dropped
    field.update(1 / 30, cam());
    expect(field.liveCount).toBe(CAPACITY);
    // the dropped grain's coordinates appear nowhere
    let found = false;
    for (let i = 0; i < CAPACITY; i++) if (field.pos[i * 3] === 999999) found = true;
    expect(found).toBe(false);
  });

  it("derives drag from kind when not given: powder vs clod", () => {
    const { field } = makeField();
    field.emit(0, 0, 0, 0, 0, 0, 0.1, 10, 0); // powder
    field.emit(1, 0, 0, 0, 0, 0, 0.1, 10, 1); // clod
    expect(field.drag[1]).toBeLessThan(field.drag[0]);
  });

  it("honours an explicit drag override", () => {
    const { field } = makeField();
    field.emit(0, 0, 0, 0, 0, 0, 0.1, 10, 0, 2.5);
    expect(field.drag[0]).toBe(2.5);
  });
});

describe("SprayField.update simulation", () => {
  it("reports liveCount accurately and retires aged-out grains", () => {
    const { field } = makeField();
    field.emit(0, 50, 0, 0, 0, 0, 0.1, 0.001, 0); // life shorter than one step
    field.emit(1, 50, 1, 0, 0, 0, 0.1, 100, 0);
    field.update(1 / 30, cam());
    expect(field.liveCount).toBe(2); // aged grains still counted on the frame they expire
    field.update(1 / 30, cam());
    expect(field.liveCount).toBe(1); // expired grain retired on the next pass
  });
  it("writes zero size for dead slots so their quads collapse", () => {
    const { field } = makeField();
    field.emit(0, 50, 0, 0, 0, 0, 0.1, 0.001, 0);
    field.update(1 / 30, cam()); // age crosses life
    field.update(1 / 30, cam()); // retire pass
    const d = field._texData;
    expect(d[3]).toBe(0);
    expect(d[CAPACITY * 4 + 3]).toBe(0);
    expect(field.liveCount).toBe(0);
  });

  it("grains land on the snow line: clamped to terrain height, vertical velocity killed", () => {
    const terrain = { heightAt: () => 7 };
    const { field } = makeField(terrain);
    field.emit(0, 7.05, 0, 4, -8, 3, 0.1, 100, 1); // clod, already below the surface after one step
    field.update(1 / 30, cam());
    expect(field.pos[1]).toBe(7); // clamped to the snow line, never through it
    expect(field.vel[1]).toBe(0);
    expect(Math.abs(field.vel[0])).toBeLessThan(4); // horizontal friction applied
    expect(Math.abs(field.vel[2])).toBeLessThan(3);
  });

  it("applies gravity to vertical velocity", () => {
    const { field } = makeField();
    field.emit(0, 100, 0, 0, 0, 0, 0.1, 100, 1, 0); // zero drag: pure gravity
    field.update(1 / 30, cam());
    expect(field.vel[1]).toBeLessThan(0);
    expect(field.vel[1]).toBeCloseTo(-9.81 / 30, 5);
  });

  it("decays horizontal velocity toward the wind (zero with windStrength=0)", () => {
    const { field } = makeField();
    field.emit(0, 100, 0, 10, 0, -6, 0.1, 100, 0); // powder
    const vx0 = field.vel[0];
    const vz0 = field.vel[2];
    field.update(1 / 30, cam());
    expect(Math.abs(field.vel[0])).toBeLessThan(Math.abs(vx0));
    expect(Math.abs(field.vel[2])).toBeLessThan(Math.abs(vz0));
  });

  it("powder bleeds horizontal speed faster than a heavy clod", () => {
    const { field } = makeField();
    field.emit(0, 100, 0, 10, 0, 0, 0.1, 100, 0); // powder, drag 5.2
    field.emit(1, 100, 0, 10, 0, 0, 0.1, 100, 1); // clod, drag 1.1
    field.update(1 / 30, cam());
    expect(Math.abs(field.vel[3])).toBeGreaterThan(Math.abs(field.vel[0]));
  });

  it("integrates positions from velocities", () => {
    const { field } = makeField();
    field.emit(0, 100, 0, 3, 0, -2, 0.1, 100, 1, 0);
    field.update(1 / 30, cam());
    expect(field.pos[0]).toBeCloseTo(0.1, 5); // 3 * (1/30)
    expect(field.pos[2]).toBeCloseTo(-2 / 30, 5);
  });


  it("a landed grain ages faster than an airborne one", () => {
    const terrain = { heightAt: () => 0 };
    const { field } = makeField(terrain);
    field.emit(0, 0.01, 0, 0, -20, 0, 0.1, 100, 1); // lands this step
    field.emit(1, 100, 0, 0, 0, 0, 0.1, 100, 1); // stays airborne
    field.update(1 / 30, cam());
    expect(field.pos[1]).toBe(0); // landed
    expect(field.age[0]).toBeGreaterThan(field.age[1]); // settle multiplier applied
  });

  it("never lets a grain fall below the terrain height over many steps", () => {
    const terrain = { heightAt: () => 3 };
    const { field } = makeField(terrain);
    field.emit(0, 6, 0, 0, 0, 0, 0.1, 100, 0);
    for (let n = 0; n < 120; n++) field.update(1 / 30, cam());
    expect(field.pos[1]).toBeGreaterThanOrEqual(3);
  });

  it("works without a terrain reference (grains keep falling)", () => {
    const { field } = makeField(null);
    field.emit(0, 50, 0, 0, 0, 0, 0.1, 100, 0);
    for (let n = 0; n < 30; n++) field.update(1 / 30, cam());
    expect(field.pos[1]).toBeLessThan(50);
  });
});

describe("SprayField._texData packing", () => {
  it("writes row0 = pos+size*grow and row1 = age01/seed/kind/alpha", () => {
    const { field } = makeField();
    field.emit(4, 50, -2, 0, 0, 0, 0.5, 1, 0); // powder, life 1s
    field.update(1 / 30, cam());
    const d = field._texData;
    const h = 1 / 30;
    const a01 = h / 1;
    // row 0
    expect(d[0]).toBeCloseTo(field.pos[0], 5);
    expect(d[1]).toBeCloseTo(field.pos[1], 5);
    expect(d[2]).toBeCloseTo(field.pos[2], 5);
    expect(d[3]).toBeCloseTo(0.5 * (1 + a01 * 1.3), 5); // powder grows with age
    // row 1 lives at (CAPACITY + i) * 4
    const t1 = CAPACITY * 4;
    expect(d[t1]).toBeCloseTo(a01, 6);
    expect(d[t1 + 1]).toBe(field.seed[0]);
    expect(d[t1 + 2]).toBe(0); // kind
    const expectedAlpha = Math.min(1, a01 * 8) * (1 - a01) * (1 - a01);
    expect(d[t1 + 3]).toBeCloseTo(expectedAlpha, 6);
  });

  it("clods do not grow; powder puffs expand", () => {
    const { field } = makeField();
    field.emit(0, 50, 0, 0, 0, 0, 0.5, 1, 1); // clod
    field.update(1 / 30, cam());
    expect(field._texData[3]).toBeCloseTo(0.5, 6); // size unchanged
  });

  it("seed and kind are preserved across updates", () => {
    const { field } = makeField();
    field.emit(7, 30, 11, 1, 2, 3, 0.2, 100, 1);
    const seed = field.seed[0];
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(1);
    for (let n = 0; n < 10; n++) field.update(1 / 30, cam());
    expect(field.seed[0]).toBe(seed);
    expect(field.kind[0]).toBe(1);
    expect(field._texData[CAPACITY * 4 + 1]).toBe(seed);
    expect(field._texData[CAPACITY * 4 + 2]).toBe(1);
  });

  it("alpha fades in from zero and fades out toward end of life", () => {
    const { field } = makeField();
    field.emit(0, 50, 0, 0, 0, 0, 0.2, 0.5, 0); // short-lived powder
    field.update(1 / 30, cam());
    const early = field._texData[CAPACITY * 4 + 3];
    expect(early).toBeGreaterThan(0); // fade-in already underway (a01*8 >= ~0.27)
    // drive to near end of life
    for (let n = 0; n < 20; n++) field.update(1 / 30, cam());
    const late = field._texData[CAPACITY * 4 + 3];
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThanOrEqual(0);
  });
});

describe("SprayField visibility", () => {
  // Mirrors every sibling particle system (waterBody, crystals,
  // smokeTrails, muzzleMarkers all toggle mesh.visible from liveCount).
  it("mesh.visible is false when liveCount reaches 0", () => {
    const { field } = makeField();
    expect(field.mesh.visible).toBe(true); // construction default
    field.emit(0, 50, 0, 0, 0, 0, 0.1, 0.001, 0);
    field.update(1 / 30, cam());
    field.update(1 / 30, cam());
    expect(field.liveCount).toBe(0);
    expect(field.mesh.visible).toBe(false);
  });
});
