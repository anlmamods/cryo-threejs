import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three";
import { SurfWake } from "../src/vfx/surfWake.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

// ---------------------------------------------------------------------------
// Stubs — the gfx surface SurfWake touches is only addMesh/LAYER/blackTex/whiteTex.
// ---------------------------------------------------------------------------

const LAYER = { SKY: 4, OPAQUE: 1, BLEND: 2 };

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: unknown; order: unknown }> = [];
  const gfx = {
    addMesh(mesh: THREE.Object3D, layer: number, order: number) {
      added.push({ mesh, layer, order });
      return mesh;
    },
    LAYER,
    blackTex: new THREE.Texture(),
    whiteTex: new THREE.Texture(),
  };
  return { gfx, added };
}

const terrain = { heightAt: (_x: number, _z: number) => 7 };

interface TestController {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  facing: number;
  speed: number;
  surf: number;
  carve: number;
  lift01: number;
  crashing: boolean;
}

function makeController(): TestController {
  return {
    position: new THREE.Vector3(0, 2, 0),
    velocity: new THREE.Vector3(0, 0, 10),
    facing: 0,
    speed: 10,
    surf: 1,
    carve: 0,
    lift01: 0,
    crashing: false,
  };
}

function makeSpray() {
  const calls: Array<Record<string, number>> = [];
  const spray = {
    emit(
      x: number, y: number, z: number,
      vx: number, vy: number, vz: number,
      size: number, life: number, kind: number, drag: number
    ) {
      calls.push({ x, y, z, vx, vy, vz, size, life, kind, drag });
    },
  };
  return { spray, calls };
}

const cam = () => new THREE.Vector3(0, 5, -3);

/** Advance the craft along its velocity and step the wake. */
function step(wake: SurfWake, ch: TestController, dt: number, frames: number, camera = cam()) {
  for (let i = 0; i < frames; i++) {
    ch.position.x += ch.velocity.x * dt;
    ch.position.y += ch.velocity.y * dt;
    ch.position.z += ch.velocity.z * dt;
    wake.update(dt, camera);
  }
}

function makeWake(
  ch: TestController | null = makeController(),
  sprayObj: { spray: { emit(...a: number[]): void } } | null = null
) {
  const { gfx, added } = makeGfx();
  const wake = new SurfWake(gfx as never, null, null, ch, sprayObj ? (sprayObj.spray as never) : null, terrain);
  return { wake, added };
}

beforeAll(() => {
  registerShaders();
});

let savedWakeHeight: number;
let savedWakeSpray: number;

beforeEach(() => {
  savedWakeHeight = S.wakeHeight as number;
  savedWakeSpray = S.wakeSpray as number;
  S.wakeHeight = 1;
  S.wakeSpray = 1;
});

afterEach(() => {
  S.wakeHeight = savedWakeHeight;
  S.wakeSpray = savedWakeSpray;
  vi.restoreAllMocks();
});

describe("SurfWake construction", () => {
  it("registers its mesh on the opaque layer and starts idle", () => {
    const { wake, added } = makeWake();
    expect(added.length).toBe(1);
    expect(added[0].layer).toBe(LAYER.OPAQUE);
    expect(wake.mesh.visible).toBe(false);
    expect(wake._count).toBe(0);
    expect(wake._odo).toBe(0);
    expect(wake._clock).toBe(0);
    expect(wake._enabled).toBe(true);
  });

  it("registers one depth caster per cascade when shadows are provided", () => {
    const { gfx } = makeGfx();
    const casters: Array<{ mesh: unknown; count: number }> = [];
    const shadows = {
      registerCaster(mesh: unknown, factory: (c: number) => unknown, count: number) {
        for (let c = 0; c < count; c++) factory(c);
        casters.push({ mesh, count });
      },
    };
    const ch = makeController();
    new SurfWake(gfx as never, null, shadows as never, ch, null, terrain);
    expect(casters.length).toBe(1);
    expect(casters[0].count).toBeGreaterThanOrEqual(2);
  });
});

describe("SurfWake.update — odometer and clock", () => {
  it("advances _clock by dt and _odo by horizontal travel only", () => {
    const ch = makeController();
    ch.velocity.set(3, 99, 4); // horizontal hypot = 5
    const { wake } = makeWake(ch);
    wake.update(0.1, cam());
    expect(wake._clock).toBeCloseTo(0.1, 6);
    expect(wake._odo).toBeCloseTo(0.5, 6);
  });

  it("still advances the clock with no controller, but not the odometer", () => {
    const { gfx } = makeGfx();
    const wake = new SurfWake(gfx as never, null, null, null, null, terrain);
    wake.update(0.25, cam());
    expect(wake._clock).toBeCloseTo(0.25, 6);
    expect(wake._odo).toBe(0);
    expect(wake.mesh.visible).toBe(false);
  });
});

describe("SurfWake head rewrite vs ring growth", () => {
  it("writes the first sample at the bow and stamps it from the terrain query", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    wake.update(0.05, cam());
    expect(wake._count).toBe(1);
    // facing 0 -> bow offset along +z by BOW_LEAD; right vector = (cos, -sin)
    expect(wake._x[0]).toBeCloseTo(0, 6);
    expect(wake._z[0]).toBeCloseTo(0.55, 6);
    expect(wake._y[0]).toBe(7); // terrain stub height
    expect(wake._rx[0]).toBeCloseTo(1, 6);
    expect(wake._rz[0]).toBeCloseTo(0, 6);
    expect(wake._travel[0]).toBe(wake._odo);
    expect(wake._laid[0]).toBeCloseTo(wake._clock, 6);
  });

  it("commits the second sample unconditionally on the next active frame", () => {
    const ch = makeController();
    ch.velocity.set(0, 0, 0); // active (speed 10) but bow does not move
    const { wake } = makeWake(ch);
    wake.update(0.05, cam());
    expect(wake._count).toBe(1);
    wake.update(0.05, cam());
    expect(wake._count).toBe(2); // count === 1 forces a commit
    const headAfter = wake._head;
    wake.update(0.05, cam());
    // bow unmoved since the seed: no new sample is committed
    expect(wake._count).toBe(2);
    expect(wake._head).toBe(headAfter);
  });

  it("grows the ring while moving and reaches an age-based steady state", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    ch.velocity.set(0, 0, 10);
    // 0.5 m per frame at dt=0.05, well past the 0.3 m commit step
    wake.update(0.05, cam());
    expect(wake._count).toBe(1);
    step(wake, ch, 0.05, 4);
    expect(wake._count).toBe(5);
    // A long surf cannot fill the ring: the age-based retire drains samples
    // as fast as commits lay them, settling at ~LIFE worth of travel.
    step(wake, ch, 0.05, 200);
    const steady = wake._count;
    expect(steady).toBeGreaterThan(2);
    expect(steady).toBeLessThan(96);
    step(wake, ch, 0.05, 20);
    expect(wake._count).toBe(steady);
  });

  it("does not write the head while surfing is below the floor", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 3);
    const count = wake._count;
    ch.surf = 0;
    step(wake, ch, 0.05, 5);
    expect(wake._count).toBe(count); // no new samples laid, none aged out yet
  });

  it("does not lay samples while crashing even if surf is pinned open", () => {
    const ch = makeController();
    ch.crashing = true;
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 5);
    expect(wake._count).toBe(0);
  });
});

describe("SurfWake._retire — age-based sample drop", () => {
  it("drains the spine monotonically to zero once samples age out", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 6);
    expect(wake._count).toBeGreaterThan(1);

    ch.surf = 0;
    ch.velocity.set(0, 0, 0);
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) {
      wake.update(0.1, cam()); // 1.2 s total — past LIFE
      counts.push(wake._count);
    }
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
    expect(counts[counts.length - 1]).toBe(0);
  });

  it("keeps young samples while draining old ones from the tail", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 8);
    const total = wake._count;
    ch.surf = 0;
    ch.velocity.set(0, 0, 0);
    // Advance far enough to retire the oldest sample(s), but not the newest
    let guard = 0;
    while (wake._count >= total && guard++ < 40) wake.update(0.05, cam());
    expect(wake._count).toBeLessThan(total);
    expect(wake._count).toBeGreaterThanOrEqual(1); // young samples survive
  });
});

describe("SurfWake amplitude falloff behind the craft", () => {
  it("resolves larger amplitude at the head than at the aged tail", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 12); // 0.6 s of travel, oldest samples aged but not retired
    expect(wake._count).toBeGreaterThan(3);
    // Newest-first column order: distances are non-decreasing with j (the
    // live head is re-seeded on every commit, so columns 0 and 1 can tie).
    for (let j = 0; j + 1 < wake._count; j++) {
      expect(wake._dist[j]).toBeLessThanOrEqual(wake._dist[j + 1]);
    }
    expect(wake._dist[wake._count - 1]).toBeGreaterThan(wake._dist[0]);
    const head = wake._ampL[0] + wake._ampR[0];
    const tail = wake._ampL[wake._count - 1] + wake._ampR[wake._count - 1];
    expect(head).toBeGreaterThan(tail);
    expect(tail).toBeGreaterThan(0);
  });

  it("produces zero amplitude when the wakeHeight setting is zeroed", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 6);
    expect(wake._count).toBeGreaterThanOrEqual(2);
    S.wakeHeight = 0;
    wake.update(0.05, cam());
    expect(wake.mesh.visible).toBe(false);
  });
});

describe("SurfWake._maybeRestart gate", () => {
  it("is a no-op on an empty spine", () => {
    const { wake } = makeWake();
    expect(() => wake._maybeRestart()).not.toThrow();
    expect(wake._count).toBe(0);
  });

  it("keeps fresh samples when the run resumes within the restart window", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 4);
    const count = wake._count;
    ch.surf = 0;
    ch.velocity.set(0, 0, 0);
    wake.update(0.05, cam()); // 0.05 s idle — well within RESTART_AGE
    wake.update(0.05, cam());
    ch.surf = 1;
    ch.velocity.set(0, 0, 10);
    wake.update(0.05, cam()); // resuming: spine must NOT be discarded
    expect(wake._count).toBeGreaterThanOrEqual(count);
  });

  it("discards a stale spine when the run resumes after the restart window", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 4);
    expect(wake._count).toBeGreaterThan(1);
    ch.surf = 0;
    ch.velocity.set(0, 0, 0);
    wake.update(0.1, cam());
    wake.update(0.1, cam());
    wake.update(0.1, cam()); // 0.3 s idle > RESTART_AGE, < LIFE (retire spares it)
    const laidBefore = wake._laid[wake._head];
    ch.surf = 1;
    ch.velocity.set(0, 0, 10);
    wake.update(0.05, cam());
    // Spine was reset by _maybeRestart, then a single fresh sample was laid
    expect(wake._count).toBe(1);
    expect(wake._laid[wake._head]).toBeGreaterThan(laidBefore);
  });
});

describe("SurfWake.setEnabled", () => {
  it("hides the mesh and keeps it hidden across updates", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 6);
    wake.setEnabled(false);
    expect(wake.mesh.visible).toBe(false);
    step(wake, ch, 0.05, 4);
    expect(wake.mesh.visible).toBe(false);
  });

  it("freezes nothing else: the spine and plume keep running while disabled", () => {
    // Documents current behavior — setEnabled only gates visibility and the
    // uniform upload; emission is NOT frozen. See report.
    const ch = makeController();
    const sprayStub = makeSpray();
    const { wake } = makeWake(ch, sprayStub);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    step(wake, ch, 0.05, 6);
    wake.setEnabled(false);
    const clock = wake._clock;
    const emitted = sprayStub.calls.length;
    step(wake, ch, 0.05, 3);
    expect(wake._clock).toBeGreaterThan(clock);
    expect(wake._count).toBeGreaterThan(1);
    expect(sprayStub.calls.length).toBeGreaterThan(emitted);
  });

  it("restores visibility when re-enabled with a live spine", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 6);
    wake.setEnabled(false);
    wake.setEnabled(true);
    wake.update(0.05, cam());
    expect(wake.mesh.visible).toBe(true);
  });
});

describe("SurfWake._pushUniforms", () => {
  it("publishes the craft camera position into the bound uniform", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    const camera = new THREE.Vector3(1, 8, -4);
    step(wake, ch, 0.05, 4, camera);
    const uniforms = wake.material.uniforms as Record<string, { value: unknown }>;
    // Bound by reference to the module's private vector, not a copy
    const bound = uniforms.cameraPos.value as THREE.Vector3;
    expect(bound).toBe(wake._camPos);
    expect(bound.x).toBeCloseTo(1, 6);
    expect(bound.y).toBeCloseTo(8, 6);
    expect(bound.z).toBeCloseTo(-4, 6);
  });

  it("publishes count/time/debug and refreshes depth + prepass materials", () => {
    const ch = makeController();
    const { gfx } = makeGfx();
    const shadows = {
      registerCaster(_mesh: unknown, factory: (c: number) => THREE.Material, _count: number) {
        factory(0);
      },
    };
    const wake = new SurfWake(gfx as never, null, shadows as never, ch, null, terrain);
    const prepassMats: THREE.Material[] = [];
    wake.registerPrepass({
      registerCaster(_mesh: THREE.Object3D, mat: THREE.Material) {
        prepassMats.push(mat);
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    step(wake, ch, 0.05, 4);

    const uniforms = wake.material.uniforms as Record<string, { value: unknown }>;
    expect(uniforms.wakeCount.value).toBe(wake._count);
    expect(uniforms.wakeTime.value).toBe(wake._clock);
    expect(uniforms.wakeDebug.value).toBe(wake.debug);

    expect(wake._depthMats.length).toBe(1);
    expect(wake._depthMats[0].uniforms.wakeCount.value).toBe(wake._count);
    expect(wake._depthMats[0].uniforms.wakeTime.value).toBe(wake._clock);

    expect(prepassMats.length).toBe(1);
    const prepassMat = prepassMats[0] as THREE.RawShaderMaterial;
    const prepassUniforms = prepassMat.uniforms as Record<string, { value: unknown }>;
    expect(prepassUniforms.wakeCount.value).toBe(wake._count);
    expect(prepassUniforms.wakeTime.value).toBe(wake._clock);
  });

  it("skips the uniform upload while the mesh is hidden", () => {
    const ch = makeController();
    const { wake } = makeWake(ch);
    step(wake, ch, 0.05, 4);
    const uniforms = wake.material.uniforms as Record<string, { value: unknown }>;
    wake.setEnabled(false);
    const frozenTime = uniforms.wakeTime.value;
    wake.update(0.5, cam()); // long step; mesh stays hidden
    expect(uniforms.wakeTime.value).toBe(frozenTime); // not re-uploaded
  });
});

describe("SurfWake plume emission", () => {
  it("sheds grains while surfing fast and none while inactive", () => {
    const ch = makeController();
    const sprayStub = makeSpray();
    const { wake } = makeWake(ch, sprayStub);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    step(wake, ch, 0.05, 6);
    expect(sprayStub.calls.length).toBeGreaterThan(0);

    sprayStub.calls.length = 0;
    ch.surf = 0;
    ch.velocity.set(0, 0, 0);
    step(wake, ch, 0.05, 4);
    expect(sprayStub.calls.length).toBe(0);
    expect(wake._plumeOwed).toBe(0);
  });
});
