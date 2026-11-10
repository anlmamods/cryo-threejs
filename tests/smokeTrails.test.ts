import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { SmokeTrails } from "../src/vfx/smokeTrails.js";
import { registerShaders } from "../src/shaders/registry.js";

const POOL = 160;

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: unknown; order: unknown }> = [];
  const gfx = {
    addMesh(mesh: THREE.Mesh, layer: number, order: number) {
      added.push({ mesh, layer, order });
      return mesh;
    },
    LAYER: { SKY: 0, OPAQUE: 1, BLEND: 2 },
    scene: new THREE.Scene(),
  };
  return { gfx, added };
}

function makeTrails() {
  const { gfx, added } = makeGfx();
  const trails = new SmokeTrails(gfx as never);
  return { trails, added };
}

const cam = () => new THREE.Vector3(0, 10, 0);

function emitSmoke(t: SmokeTrails, x = 0, y = 0, z = 0, life = 2) {
  t.emit(x, y, z, 0, 0, 0, 0.5, 0.1, life, 0.1, 0.1, 0.1, 0.8, true);
}

beforeAll(() => {
  registerShaders();
});

describe("SmokeTrails construction", () => {
  it("registers the mesh on the blend layer and starts invisible with an empty pool", () => {
    const { trails, added } = makeTrails();
    expect(added.length).toBe(1);
    expect(added[0].layer).toBe(2);
    expect(added[0].order).toBe(44);
    expect(trails.mesh.visible).toBe(false);
    expect(trails._next).toBe(0);
    expect(trails.mesh.metadata.vertices).toBe(POOL * 4);
    expect(trails.mesh.metadata.triangles).toBe(POOL * 2);
  });
});

describe("SmokeTrails.emit ring", () => {
  it("writes into the slot at _next and advances the cursor", () => {
    const { trails } = makeTrails();
    trails.emit(1, 2, 3, 4, 5, 6, 0.5, 0.25, 3, 0.2, 0.3, 0.4, 0.9, true);
    expect(trails._next).toBe(1);
    expect(trails._pos[0]).toBe(1);
    expect(trails._pos[1]).toBe(2);
    expect(trails._pos[2]).toBe(3);
    expect(trails._vel[0]).toBe(4);
    expect(trails._vel[1]).toBe(5);
    expect(trails._vel[2]).toBe(6);
    expect(trails._life[0]).toBe(3);
    expect(trails._life0[0]).toBe(3);
    expect(trails._size[0]).toBe(0.5);
    expect(trails._grow[0]).toBe(0.25);
    expect(trails._col[0]).toBeCloseTo(0.2);
    expect(trails._col[3]).toBeCloseTo(0.9);
    expect(trails._buoy[0]).toBe(1);
  });

  it("wraps the cursor back to slot 0 after a full pool, overwriting the oldest puff", () => {
    const { trails } = makeTrails();
    for (let i = 0; i < POOL; i++) emitSmoke(trails, i, 0, 0, 10);
    expect(trails._next).toBe(0);
    emitSmoke(trails, 999, 0, 0, 10);
    expect(trails._next).toBe(1);
    expect(trails._pos[0]).toBe(999);
    expect(trails._pos[3 * 1]).toBe(1); // slot 1 untouched
  });

  it("records flame puffs as non-buoyant", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 0, 0, 0, 0.5, 0, 1, 1, 0.5, 0, 0.9, false);
    expect(trails._buoy[0]).toBe(0);
  });
});

describe("SmokeTrails.update simulation", () => {
  it("integrates position by velocity and ages the puff", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 1, 0, 0, 0.5, 0, 5, 0.1, 0.1, 0.1, 0.8, false);
    trails.update(0.5, cam());
    expect(trails._life[0]).toBeCloseTo(4.5);
    expect(trails._pos[0]).toBeGreaterThan(0);
    expect(trails._pos[0]).toBeLessThan(0.5); // drag shrank the step
  });

  it("applies buoyancy to smoke but not to flame", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 0, 0, 0, 0.5, 0, 5, 0.1, 0.1, 0.1, 0.8, true);
    trails.emit(100, 0, 0, 0, 0, 0, 0.5, 0, 5, 0.1, 0.1, 0.1, 0.8, false);
    trails.update(0.25, cam());
    expect(trails._vel[1]).toBeGreaterThan(0); // smoke rose
    expect(trails._vel[3 + 1]).toBeCloseTo(0); // flame did not
  });

  it("decays velocity by drag each step", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 10, 0, 0, 0.5, 0, 5, 0.1, 0.1, 0.1, 0.8, false);
    trails.update(0.1, cam());
    // drag = 1 - min(0.9, 1.6 * 0.1) = 0.84
    expect(trails._vel[0]).toBeCloseTo(8.4);
  });

  it("grows puff radius by grow rate but never shrinks below the minimum", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 0, 0, 0, 1.0, 2.0, 5, 0.1, 0.1, 0.1, 0.8, true);
    trails.update(0.5, cam());
    expect(trails._size[0]).toBeCloseTo(2.0);
    trails.emit(10, 0, 0, 0, 0, 0, 0.05, -5.0, 5, 0.1, 0.1, 0.1, 0.8, true);
    for (let i = 0; i < 20; i++) trails.update(0.1, cam());
    expect(trails._size[1]).toBeCloseTo(0.02, 7); // Float32Array storage
  });

  it("fades alpha in from zero at birth and back toward zero at end of life", () => {
    const { trails } = makeTrails();
    trails.emit(0, 0, 0, 0, 0, 0, 0.5, 0, 1, 1, 1, 1, 1, false);
    trails.update(0.001, cam());
    const c = (POOL + 0) * 4;
    const alphaAtBirth = trails._data[c + 3];
    expect(alphaAtBirth).toBeLessThan(0.1); // just shed — still fading in
    // near end of life: t01 small → envelope small
    for (let i = 0; i < 8; i++) trails.update(0.1, cam());
    const alphaNearEnd = trails._data[c + 3];
    expect(alphaNearEnd).toBeLessThan(0.35);
  });

  it("packs position/size into row 0 and colour into row 1 of the data texture", () => {
    const { trails } = makeTrails();
    trails.emit(7, 8, 9, 0, 0, 0, 0.75, 0, 5, 0.2, 0.4, 0.6, 0.9, false);
    trails.update(0.01, cam());
    expect(trails._data[0]).toBeCloseTo(7);
    expect(trails._data[1]).toBeCloseTo(8);
    expect(trails._data[2]).toBeCloseTo(9);
    expect(trails._data[3]).toBeCloseTo(0.75);
    const c = (POOL + 0) * 4;
    expect(trails._data[c]).toBeCloseTo(0.2);
    expect(trails._data[c + 1]).toBeCloseTo(0.4);
    expect(trails._data[c + 2]).toBeCloseTo(0.6);
  });

  it("copies cameraPos into the shared uniform vector when provided", () => {
    const { trails } = makeTrails();
    trails.update(0.01, new THREE.Vector3(3, 4, 5));
    expect(trails._cameraPos.x).toBe(3);
    expect(trails._cameraPos.y).toBe(4);
    expect(trails._cameraPos.z).toBe(5);
    expect(trails.material.uniforms.cameraPos.value).toBe(trails._cameraPos);
  });
});
describe("SmokeTrails retire cycle", () => {
  it("retires puffs whose life expires and hides the mesh when the pool drains", () => {
    const { trails } = makeTrails();
    emitSmoke(trails, 0, 0, 0, 0.1);
    trails.update(0.05, cam());
    expect(trails.mesh.visible).toBe(true);
    trails.update(0.2, cam()); // life crosses zero this step; puff still processed once
    expect(trails._life[0]).toBeLessThanOrEqual(0);
    trails.update(0.01, cam()); // now the death check at the loop top retires it
    expect(trails.mesh.visible).toBe(false);
    expect(trails._data[3]).toBe(0); // dead slot radius zeroed
  });

  it("spawns on a burn cadence, accumulates, then drains to invisible", () => {
    const { trails } = makeTrails();
    // Burn for 2 simulated seconds, shedding a puff every 0.25 s.
    for (let step = 0; step < 20; step++) {
      if (step % 5 === 0) emitSmoke(trails, step * 0.1, 1, 0, 1.0);
      trails.update(0.1, cam());
    }
    expect(trails.mesh.visible).toBe(true);
    const liveDuringBurn = [...trails._life].filter((l) => l > 0).length;
    expect(liveDuringBurn).toBeGreaterThan(0);
    // Keep simulating past every puff's life — everything must retire.
    for (let step = 0; step < 30; step++) trails.update(0.1, cam());
    expect(trails.mesh.visible).toBe(false);
    expect([...trails._life].every((l) => l <= 0)).toBe(true);
  });

  it("recycles expired slots for new emissions after a full drain", () => {
    const { trails } = makeTrails();
    emitSmoke(trails, 1, 0, 0, 0.1);
    trails.update(0.5, cam()); // life crosses zero this step
    trails.update(0.01, cam()); // retired on the following pass
    expect(trails.mesh.visible).toBe(false);
    emitSmoke(trails, 42, 0, 0, 5);
    trails.update(0.01, cam());
    expect(trails.mesh.visible).toBe(true);
    // Ring cursor kept advancing; the new puff landed in slot 1.
    expect(trails._pos[3]).toBe(42);
  });
});
