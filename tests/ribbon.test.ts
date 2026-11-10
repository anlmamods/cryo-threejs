import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Ribbon } from "../src/spells/ribbon.js";
import { PROFILE_TUBE } from "../src/spells/waterBody.js";
import { SpellLights } from "../src/spells/spellLights.js";
import type { SpellContext } from "../src/spells/spellSystem.js";

// ---------------------------------------------------------------------------
// Ribbon (spell 2) — strand-on-a-stick simulation. The ribbon takes everything
// it needs through SpellContext; the harness hand-rolls every peer (counting
// spray/deform, fake strand table, kinematic rig with forward/right/up), so
// nothing here touches GL. `time` is a plain number advanced by run(), the
// same way SpellSystem bumps it.
// ---------------------------------------------------------------------------

const DT = 1 / 60;
const HAND = { x: 0.5, y: 1.0, z: -0.25 };

interface BrushCall {
  x: number; z: number; radius: number; depth: number; berm: number;
  pack: number; ice: number; yaw: number; elongation: number; edge: number;
}
interface EmitCall {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number; life: number; kind: number; drag: number;
}
interface ParamCall { s: number; profile: number; milkiness: number; alpha: number; count: number }
interface ColumnCall {
  s: number; c: number; x: number; y: number; z: number; radius: number;
  twist: number; dist: number; age01: number; foam: number;
}

function makeDeform() {
  const brushes: BrushCall[] = [];
  return {
    brushes,
    brush(x: number, z: number, radius: number, depth: number, berm: number,
      compression: number, ice: number, yaw?: number, elongation?: number, edge?: number) {
      brushes.push({
        x, z, radius, depth, berm, pack: compression, ice,
        yaw: yaw ?? 0, elongation: elongation ?? 1, edge: edge ?? 1,
      });
    },
  };
}

function makeSpray() {
  const emits: EmitCall[] = [];
  return {
    emits,
    emit(x: number, y: number, z: number, vx: number, vy: number, vz: number,
      size: number, life: number, kind: number, drag?: number) {
      emits.push({ x, y, z, vx, vy, vz, size, life, kind, drag: drag ?? -1 });
    },
  };
}

function makeWater(poolSize = 8) {
  const used = Array.from({ length: poolSize }, () => false);
  const acquired: number[] = [];
  const released: number[] = [];
  const params: ParamCall[] = [];
  const columns: ColumnCall[] = [];
  return {
    poolSize, used, acquired, released, params, columns,
    acquire() {
      const s = used.indexOf(false);
      if (s < 0) return -1;
      used[s] = true;
      acquired.push(s);
      return s;
    },
    release(s: number) {
      released.push(s);
      if (s >= 0 && s < poolSize) used[s] = false;
    },
    setParams(s: number, profile: number, milkiness: number, alpha: number, count: number) {
      params.push({ s, profile, milkiness, alpha, count });
    },
    column(s: number, c: number, x: number, y: number, z: number, radius: number,
      _rx: number, _ry: number, _rz: number, twist: number,
      dist: number, age01: number, foam: number, _flatten: number) {
      columns.push({ s, c, x, y, z, radius, twist, dist, age01, foam });
    },
  };
}

function makeCtx(over: { terrainH?: number; sprayScale?: number } = {}) {
  const lights = new SpellLights();
  lights.scale = 1;
  const water = makeWater();
  const spray = makeSpray();
  const deform = makeDeform();
  const terrain = {
    h: over.terrainH ?? 0,
    heightAt(_x?: number, _z?: number) { return this.h; },
  };
  const rig = {
    forward: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    trauma: 0,
    addTrauma(n: number) { this.trauma += n; },
  };
  const crystals = { plants: [] as unknown[], plant() { /* unused */ } };
  const ctx = {
    controller: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: 0, cast: 0 },
    figure: null,
    rig, terrain, deform, spray, water, crystals, lights,
    time: 0,
    sprayScale: over.sprayScale ?? 1,
    handPosition: (_which: number, out: Float32Array, off: number) => {
      out[off] = HAND.x; out[off + 1] = HAND.y; out[off + 2] = HAND.z;
    },
  } as unknown as SpellContext;
  return { ctx, lights, water, spray, deform, crystals, rig, terrain };
}

function run(
  h: { lights: SpellLights; ctx: SpellContext },
  spell: { update(dt: number): void },
  seconds: number,
  dt = DT,
  perFrame?: (i: number) => void,
) {
  const frames = Math.ceil(seconds / dt - 1e-9);
  for (let i = 0; i < frames; i++) {
    h.lights.begin();
    spell.update(dt);
    h.ctx.time += dt;
    perFrame?.(i);
  }
  return frames;
}


beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ribbon trigger & held cast", () => {
  it("trigger seeds the strand, plants the tip at the hand, blend starts at 0", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    expect(s.active).toBe(false);
    s.trigger();
    expect(s.active).toBe(true);
    expect(s.held).toBe(true);
    expect(s.strand).toBeGreaterThanOrEqual(0);
    expect(h.water.acquired).toHaveLength(1);
    expect(s.tipX).toBeCloseTo(HAND.x, 6);
    expect(s.tipY).toBeCloseTo(HAND.y, 6);
    expect(s.tipZ).toBeCloseTo(HAND.z, 6);
    expect(s.blend).toBe(0);
    expect(s._count).toBe(0);
  });

  it("blend ramps up monotonically while held", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    let prev = s.blend;
    for (let i = 0; i < 30; i++) {
      s.update(DT);
      h.ctx.time += DT;
      expect(s.blend).toBeGreaterThanOrEqual(prev);
      expect(Number.isFinite(s.blend)).toBe(true);
      prev = s.blend;
    }
    expect(s.blend).toBeGreaterThan(0.5);
    run(h, s, 3);
    expect(s.blend).toBeGreaterThan(0.9);
  });

  it("held update advances the tip toward the aim, but the spring lags the hand", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    s.update(DT);
    // One frame in: the tip has moved but is nowhere near the ~2.5 m reach —
    // the spring gives the water its lag.
    const moved = Math.hypot(s.tipX - HAND.x, s.tipY - HAND.y, s.tipZ - HAND.z);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(1.0);
    // And it keeps advancing downrange (aim is +z).
    const z1 = s.tipZ;
    run(h, s, 0.5);
    expect(s.tipZ).toBeGreaterThan(z1);
  });

  it("held run for 5 s never produces a NaN tip or blend", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 5, DT, () => {
      expect(Number.isFinite(s.tipX) && Number.isFinite(s.tipY) && Number.isFinite(s.tipZ)).toBe(true);
      expect(Number.isFinite(s.blend)).toBe(true);
    });
  });

  it("held tip never bores into the snow — it skims at clearance", () => {
    const h = makeCtx({ terrainH: 3 });
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 2, DT, () => {
      expect(s.tipY).toBeGreaterThanOrEqual(3 + 0.10 - 1e-6);
    });
  });

  it("writes the strand every held frame once the spine is long enough", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 1.0);
    expect(s._count).toBeGreaterThanOrEqual(2);
    expect(h.water.columns.length).toBeGreaterThan(0);
    expect(h.water.params.length).toBeGreaterThan(0);
    expect(h.water.params.every(p => p.profile === PROFILE_TUBE)).toBe(true);
    expect(h.water.columns.every(c => Number.isFinite(c.x + c.y + c.z + c.radius))).toBe(true);
    expect(h.water.columns.every(c => c.radius >= 0)).toBe(true);
  });
});

describe("Ribbon commit / ring buffer", () => {
  it("_commit pushes the first sample immediately, then gates on STEP travel", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    expect(s._count).toBe(0);
    s._commit();                       // empty ring: always lays a sample
    expect(s._count).toBe(1);
    s._commit();                       // tip hasn't moved: no new sample
    expect(s._count).toBe(1);
  });

  it("ring buffer wraps at SAMPLES and keeps the newest sample at _head", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    // The spine ring holds SAMPLES (46) live samples; overflow it with
    // distinctive positions.
    const SAMPLES = 46;
    for (let i = 0; i < SAMPLES - 4; i++) s._push(i + 100, 0, 0);
    expect(s._count).toBeLessThan(SAMPLES);
    for (let i = SAMPLES - 4; i < SAMPLES + 4; i++) s._push(i + 100, 0, 0);
    expect(s._count).toBe(SAMPLES);
    expect(s._head).toBe((SAMPLES + 4) % SAMPLES);
    // Walking back from _head yields the pushed sequence in reverse.
    const newest = s._head;
    for (let j = 0; j < SAMPLES; j++) {
      const idx = (newest - j + SAMPLES * 2) % SAMPLES;
      expect(s._x[idx]).toBeCloseTo(SAMPLES + 3 - j + 100, 6);
    }
  });
});

describe("Ribbon release & throw", () => {
  it("release flips thrown, unholds, and tilts the aim slightly upward", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 0.25);
    s.release();
    expect(s.held).toBe(false);
    expect(s.thrown).toBe(true);
    expect(s._splashed).toBe(false);
    expect(s._throwT).toBe(0);
    const len = Math.hypot(s._tx, s._ty, s._tz);
    expect(len).toBeCloseTo(1, 6);
    expect(s._ty).toBeGreaterThan(0); // arcs, not flat
    expect(Math.abs(s._tz)).toBeGreaterThan(Math.abs(s._ty));
  });

  it("release on a non-held ribbon is a no-op", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.release();
    expect(s.thrown).toBe(false);
    expect(s._throwT).toBe(0);
  });

  it("release applies THROW_THRUST along the aim axis and advances the decay clock", () => {
    const h = makeCtx({ terrainH: -1000 }); // out of reach: no splash, pure flight
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 0.5);
    s.release();
    const aimBefore = s._vx * s._tx + s._vy * s._ty + s._vz * s._tz;
    s.update(DT);
    const aimAfter = s._vx * s._tx + s._vy * s._ty + s._vz * s._tz;
    // Thrust + velocity steer both push the velocity onto the aim; only
    // gravity/drag pull against it, and they are an order of magnitude smaller.
    expect(aimAfter).toBeGreaterThan(aimBefore);
    // _throwT is the clock the thrust decay (exp(-throwT·decay)) is read from.
    expect(s._throwT).toBeCloseTo(DT, 6);
    run(h, s, 0.5);
    expect(s._throwT).toBeCloseTo(0.5 + DT, 5);
  });

  it("thrown head never exceeds THROW_SPEED and drag eventually dominates", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 0.5);
    s.release();
    run(h, s, 3, DT, () => {
      const sp = Math.hypot(s._vx, s._vy, s._vz);
      expect(sp).toBeLessThanOrEqual(21 + 1e-3);
      expect(Number.isFinite(s.tipX) && Number.isFinite(s.tipY) && Number.isFinite(s.tipZ)).toBe(true);
    });
  });
});

describe("Ribbon splash", () => {
  it("ground contact fires _splash exactly once: fan spray, marks, trauma, fast drain", () => {
    const h = makeCtx(); // terrain h = 0 while held
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 1.0);               // build up a full spine
    expect(s._count).toBeGreaterThan(10);
    const brushesBefore = h.deform.brushes.length;
    const emitsBefore = h.spray.emits.length;
    expect(h.rig.trauma).toBe(0);

    // Raise the world into the thrown head: the next thrown update impacts.
    h.terrain.h = 50;
    s.release();
    s.update(DT);

    expect(s._splashed).toBe(true);
    expect(s.splashCount).toBe(1);
    expect(s.tipY).toBeCloseTo(50 + 0.05, 6);   // pinned at impact clearance
    expect(h.spray.emits.length).toBeGreaterThan(emitsBefore + 100); // impact fan
    expect(h.deform.brushes.length).toBeGreaterThanOrEqual(brushesBefore + 4); // 1 primary + 3 secondary
    expect(h.rig.trauma).toBeGreaterThan(0);

    // Further updates while pinned: no second splash.
    run(h, s, 0.25);
    expect(s.splashCount).toBe(1);

    // The splash drain is much steeper than the base retirement: the body
    // pours itself out and the spell deactivates, releasing the strand once.
    run(h, s, 1.0);
    expect(s.active).toBe(false);
    expect(s.strand).toBe(-1);
    expect(h.water.released.filter(n => n !== undefined)).toHaveLength(1);
    expect(s._count).toBeLessThan(3);
  });

  it("BURST_MIN_SAMPLES guard: too few samples at release → no burst spray", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    s.update(DT); // one commit only
    expect(s._count).toBeLessThan(3);
    s.release();  // _burst runs here — must bail out cleanly
    expect(h.spray.emits).toHaveLength(0);
    expect(s.thrown).toBe(true);
  });

  it("release with a healthy spine emits exactly BURST_COUNT scatter droplets", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 1.0);
    expect(s._count).toBeGreaterThanOrEqual(3);
    const emitsBefore = h.spray.emits.length;
    s.release();
    // sprayScale = 1, Math.random mocked at 0.5 → floor(70 * 1) = 70 droplets.
    expect(h.spray.emits.length - emitsBefore).toBe(70);
  });
});

describe("Ribbon cancel & teardown", () => {
  it("cancel() mid-flight drains cleanly and no splash ever fires afterwards", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 1.0);
    s.release();
    run(h, s, 0.05);               // genuinely mid-flight
    const emitsAtCancel = h.spray.emits.length;
    const brushesAtCancel = h.deform.brushes.length;
    // Raise the world into the head: any post-cancel contact would splash.
    h.terrain.h = 50;
    s.cancel();
    expect(s.active).toBe(false);
    expect(s.held).toBe(false);
    expect(s.thrown).toBe(false);
    expect(s.blend).toBe(0);
    expect(h.water.released).toHaveLength(1);
    run(h, s, 1.0);
    expect(s.splashCount).toBe(0);
    expect(h.spray.emits.length).toBe(emitsAtCancel);
    expect(h.deform.brushes.length).toBe(brushesAtCancel);
  });

  it("cancel() before any trigger is a safe no-op", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.cancel();
    expect(s.active).toBe(false);
    expect(s.strand).toBe(-1);
    expect(h.water.released).toHaveLength(0);
  });

  it("a thrown body drains to deactivation, releases the strand once, then stays inert", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 1.0);
    s.release();
    // Keep terrain low enough that the drain path is allowed to run to completion.
    let guard = 0;
    while (s.active && guard++ < 60 * 10) {
      h.lights.begin();
      s.update(DT);
      h.ctx.time += DT;
    }
    expect(s.active).toBe(false);
    expect(h.water.released).toHaveLength(1);
    expect(s._count).toBeLessThan(3);
    const emits = h.spray.emits.length;
    const brushes = h.deform.brushes.length;
    run(h, s, 1.0);               // post-teardown updates are no-ops
    expect(h.spray.emits.length).toBe(emits);
    expect(h.deform.brushes.length).toBe(brushes);
  });

  it("re-triggering after a full drain re-seeds cleanly and re-acquires", () => {
    const h = makeCtx();
    const s = new Ribbon(h.ctx);
    s.trigger();
    run(h, s, 0.3);
    s.release();
    let guard = 0;
    while (s.active && guard++ < 60 * 10) {
      h.lights.begin();
      s.update(DT);
      h.ctx.time += DT;
    }
    expect(s.active).toBe(false);
    s.trigger();
    expect(s.active).toBe(true);
    expect(s.held).toBe(true);
    expect(h.water.acquired.length).toBe(2);
    expect(s.tipX).toBeCloseTo(HAND.x, 6);
    expect(s._count).toBe(0);
    expect(s.blend).toBe(0);
  });
});
