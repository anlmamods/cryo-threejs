import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpellLights } from "../src/spells/spellLights.js";
import { PROFILE_SHEET, PROFILE_TUBE } from "../src/spells/waterBody.js";
import { Sweep } from "../src/spells/sweep.js";
import { Bloom } from "../src/spells/bloom.js";
import { Crystallize } from "../src/spells/crystallize.js";
import { Vortex } from "../src/spells/vortex.js";
import type { SpellContext } from "../src/spells/spellSystem.js";

// ---------------------------------------------------------------------------
// Shared ctx-stub harness
//
// The spells take everything they need through `SpellContext`, so the harness
// hand-rolls every peer: counting stubs for spray/deform/crystals, a fake
// strand table for the water body, and the *real* SpellLights pool. Nothing
// here touches GL. `time` is a plain number, bumped by `run()` the same way
// SpellSystem bumps it.
// ---------------------------------------------------------------------------

interface BrushCall {
  x: number; z: number; radius: number; depth: number; berm: number;
  pack: number; ice: number; yaw: number; elongation: number; edge: number;
}

interface EmitCall {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number; life: number; kind: number; drag: number;
}

interface PlantCall {
  x: number; y: number; z: number;
  ax: number; ay: number; az: number;
  height: number; radius: number; grow: number; stand: number;
}

interface ParamCall { s: number; profile: number; milkiness: number; alpha: number; count: number }
interface ColumnCall {
  s: number; c: number; x: number; y: number; z: number; radius: number;
  twist: number; dist: number; age01: number; foam: number;
}

interface DeformStub {
  brushes: BrushCall[];
  brush(x: number, z: number, radius: number, depth: number, berm: number,
    compression: number, ice: number, yaw?: number, elongation?: number, edge?: number): void;
}

interface SprayStub {
  emits: EmitCall[];
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number,
    size: number, life: number, kind: number, drag?: number): void;
}

interface WaterStub {
  poolSize: number;
  used: boolean[];
  acquired: number[];
  released: number[];
  params: ParamCall[];
  columns: ColumnCall[];
  acquire(): number;
  release(s: number): void;
  setParams(s: number, profile: number, milkiness: number, alpha: number, count: number): void;
  column(s: number, c: number, x: number, y: number, z: number, radius: number,
    rx: number, ry: number, rz: number, twist: number,
    dist: number, age01: number, foam: number, flatten: number): void;
  liveSlots(): number;
}

interface CrystalsStub {
  plants: PlantCall[];
  plant(x: number, y: number, z: number, ax: number, ay: number, az: number,
    height: number, radius: number, grow: number, stand: number): void;
}

interface RigStub { trauma: number; addTrauma(n: number): void }
interface TerrainStub { h: number; heightAt(x?: number, z?: number): number }
interface ControllerStub {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  facing: number;
  cast: number;
}

interface Harness {
  ctx: SpellContext;
  lights: SpellLights;
  water: WaterStub;
  spray: SprayStub;
  deform: DeformStub;
  crystals: CrystalsStub;
  rig: RigStub;
  terrain: TerrainStub;
  controller: ControllerStub;
}

function makeDeform(): DeformStub {
  const brushes: BrushCall[] = [];
  return {
    brushes,
    brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge) {
      brushes.push({
        x, z, radius, depth, berm, pack: compression, ice,
        yaw: yaw ?? 0, elongation: elongation ?? 1, edge: edge ?? 1,
      });
    },
  };
}

function makeSpray(): SprayStub {
  const emits: EmitCall[] = [];
  return {
    emits,
    emit(x, y, z, vx, vy, vz, size, life, kind, drag) {
      emits.push({ x, y, z, vx, vy, vz, size, life, kind, drag: drag ?? -1 });
    },
  };
}

/** Fake strand table mirroring WaterBody's acquire/release contract. */
function makeWater(poolSize = 8): WaterStub {
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
    release(s) {
      released.push(s); // recorded even when out of range — misuse must be visible
      if (s >= 0 && s < poolSize) used[s] = false;
    },
    setParams(s, profile, milkiness, alpha, count) {
      params.push({ s, profile, milkiness, alpha, count });
    },
    column(s, c, x, y, z, radius, _rx, _ry, _rz, twist, dist, age01, foam, _flatten) {
      columns.push({ s, c, x, y, z, radius, twist, dist, age01, foam });
    },
    liveSlots() { return used.filter(Boolean).length; },
  };
}

function makeCrystals(): CrystalsStub {
  const plants: PlantCall[] = [];
  return {
    plants,
    plant(x, y, z, ax, ay, az, height, radius, grow, stand) {
      plants.push({ x, y, z, ax, ay, az, height, radius, grow, stand });
    },
  };
}

function makeRig(): RigStub {
  return { trauma: 0, addTrauma(n) { this.trauma += n; } };
}

function makeTerrain(h = 0): TerrainStub {
  return { h, heightAt() { return this.h; } };
}

function makeController(x = 2, y = 0, z = -3): ControllerStub {
  return {
    position: { x, y, z },
    velocity: { x: 0, y: 0, z: 0 },
    facing: 0.35,
    cast: 0,
  };
}

function makeCtx(over: { terrainH?: number; sprayScale?: number; pool?: number } = {}): Harness {
  const lights = new SpellLights();
  lights.scale = 1;
  const water = makeWater(over.pool ?? 8);
  const spray = makeSpray();
  const deform = makeDeform();
  const crystals = makeCrystals();
  const rig = makeRig();
  const terrain = makeTerrain(over.terrainH ?? 0);
  const controller = makeController();
  const ctx = {
    controller, figure: null, rig, terrain, deform, spray,
    water, crystals, lights,
    time: 0,
    sprayScale: over.sprayScale ?? 1,
    handPosition: (_which: number, out: Float32Array, off: number) => {
      out[off] = 0; out[off + 1] = 1; out[off + 2] = 0;
    },
  } as unknown as SpellContext;
  return { ctx, lights, water, spray, deform, crystals, rig, terrain, controller };
}

const DT = 1 / 60;

/**
 * Drive a spell the way SpellSystem does: clear the pool, update, advance
 * ctx.time by dt. `perFrame(i)` runs after each update, before lights are
 * cleared again — use it to snapshot light state or brush counts per frame.
 */
function run(
  h: Harness,
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

/** Light intensity declared this frame (0 when nothing was declared). */
function lightIntensity(h: Harness, slot = 0) {
  return h.lights.count > slot ? h.lights.col[slot * 4 + 3] : 0;
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
describe("Sweep", () => {
  it("trigger sets active, acquires one strand, born ahead of the player", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    expect(s.active).toBe(false);
    s.trigger(1, 0);
    expect(s.active).toBe(true);
    expect(s.strand).toBeGreaterThanOrEqual(0);
    expect(h.water.acquired).toHaveLength(1);
    // Born ahead of the feet along the aim — the player is never inside it.
    expect(s.ox - h.controller.position.x).toBeGreaterThan(0);
  });

  it("a recast keeps the same strand instead of stacking", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    const strand = s.strand;
    s.trigger(0, 1);
    expect(h.water.acquired).toHaveLength(1);
    expect(s.strand).toBe(strand);
    // And the aim follows the new cast.
    expect(s.dz).toBeCloseTo(1, 6);
  });

  it("trigger with an exhausted pool never becomes active", () => {
    const h = makeCtx();
    for (let i = 0; i < h.water.poolSize; i++) h.water.acquire();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    expect(s.active).toBe(false);
    expect(s.strand).toBe(-1);
    // Free the pool again — the very next cast works.
    for (let i = 0; i < h.water.poolSize; i++) h.water.release(i);
    s.trigger(1, 0);
    expect(s.active).toBe(true);
    expect(s.strand).toBeGreaterThanOrEqual(0);
  });

  it("update before trigger is a complete no-op", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    h.lights.begin();
    s.update(DT);
    expect(h.water.columns).toHaveLength(0);
    expect(h.water.params).toHaveLength(0);
    expect(h.deform.brushes).toHaveLength(0);
    expect(h.spray.emits).toHaveLength(0);
    expect(h.lights.count).toBe(0);
  });

  it("lays a full sheet profile, 48 columns per frame, params every frame", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    const frames = run(h, s, 0.5);
    expect(h.water.columns.length).toBe(48 * frames);
    expect(h.water.params.length).toBe(frames);
    expect(h.water.params.every(p => p.profile === PROFILE_SHEET)).toBe(true);
    expect(h.water.params.every(p => p.count === 48)).toBe(true);
    expect(h.water.columns.every(c => c.foam >= 0 && c.foam <= 1)).toBe(true);
    expect(h.water.columns.every(c => c.age01 >= 0 && c.age01 < 1)).toBe(true);
  });

  it("envelope ramps to full strength, holds, then falls to zero — light tracks it", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    const intensities: number[] = [];
    let framesActive = 0;
    run(h, s, 2.4, DT, () => {
      intensities.push(s.active ? lightIntensity(h) : 0);
      if (s.active) framesActive++;
    });
    const peak = Math.max(...intensities);
    expect(peak).toBeCloseTo(13, 5);            // full envelope, mid-cast
    expect(intensities[0]).toBeLessThan(peak);  // born quiet
    // Early ramp is non-decreasing (first 0.26 s of frames).
    const rampFrames = Math.ceil(0.26 / DT);
    for (let i = 1; i < rampFrames; i++) {
      expect(intensities[i] + 1e-9).toBeGreaterThanOrEqual(intensities[i - 1]);
    }
    // Late fade is non-increasing (last 0.45 of life).
    const fadeFrames = Math.ceil(2.4 * 0.45 / DT);
    for (let i = intensities.length - fadeFrames + 1; i < intensities.length; i++) {
      if (intensities[i] === 0 && intensities[i - 1] === 0) continue;
      expect(intensities[i] - 1e-9).toBeLessThanOrEqual(intensities[i - 1]);
    }
    expect(framesActive).toBeGreaterThan(0);
  });

  it("end-of-life releases its strand exactly once and deactivates", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    const strand = s.strand;
    run(h, s, 3.0); // LIFE is 2.4 s — runs well past it
    expect(s.active).toBe(false);
    expect(s.strand).toBe(-1);
    expect(h.water.released.filter(r => r === strand)).toHaveLength(1);
    expect(h.water.liveSlots()).toBe(0);
    expect(h.lights.count).toBe(0); // nothing declared after the end
  });

  it("_end is idempotent and cancel() matches it", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    run(h, s, 3.0);
    s._end();
    s.cancel();
    expect(h.water.released).toHaveLength(1); // exactly one release across all paths
  });

  it("cancel() mid-cast releases the strand and silences the spell", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    run(h, s, 0.5);
    s.cancel();
    expect(s.active).toBe(false);
    expect(h.water.released).toHaveLength(1);
    const columns = h.water.columns.length;
    const params = h.water.params.length;
    const brushes = h.deform.brushes.length;
    const emits = h.spray.emits.length;
    run(h, s, 1.0);
    expect(h.water.columns.length).toBe(columns);
    expect(h.water.params.length).toBe(params);
    expect(h.deform.brushes.length).toBe(brushes);
    expect(h.spray.emits.length).toBe(emits);
    expect(h.lights.count).toBe(0);
  });

  it("does not track the player after cast — the wave is fixed in the world", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    const ox = s.ox, oz = s.oz;
    h.controller.position.x = 50;
    h.controller.position.z = 50;
    run(h, s, 0.5);
    expect(s.ox).toBe(ox);
    expect(s.oz).toBe(oz);
  });

  it("ploughs channel brushes along the swept path — constant shape, marching forward", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    run(h, s, 2.2);
    const brushes = h.deform.brushes;
    expect(brushes.length).toBeGreaterThan(50);
    const radius0 = brushes[0].radius;
    const elong0 = brushes[0].elongation;
    for (const b of brushes) {
      expect(b.radius).toBe(radius0);          // constant brush radius
      expect(b.elongation).toBe(elong0);       // constant along-trench elongation
      expect(b.elongation).toBeGreaterThan(1); // elongated along the trench
      expect(b.depth).toBeGreaterThan(0);      // it is cutting, not filling
      expect(b.berm).toBeGreaterThan(0);       // mass goes to the rims
      expect(Number.isFinite(b.yaw)).toBe(true);
      expect(b.ice).toBeGreaterThan(0);
    }
    // The ranks march in the aim direction as the crest advances.
    const proj = (b: BrushCall) => (b.x - s.ox) * 1 + (b.z - s.oz) * 0;
    const third = Math.floor(brushes.length / 3);
    const late = brushes.slice(-third);
    const earlyAvg = brushes.slice(0, third).reduce((a, b) => a + proj(b), 0) / third;
    const lateAvg = late.reduce((a, b) => a + proj(b), 0) / late.length;
    expect(lateAvg).toBeGreaterThan(earlyAvg);
    // Ploughing stops once the envelope collapses.
    const frozen = h.deform.brushes.length;
    run(h, s, 0.3);
    expect(h.deform.brushes.length).toBe(frozen);
  });

  it("spray cadence scales with travel speed, and with sprayScale", () => {
    const fast = makeCtx({ sprayScale: 1 });
    const none = makeCtx({ sprayScale: 0 });
    const a = new Sweep(fast.ctx);
    const b = new Sweep(none.ctx);
    a.trigger(1, 0);
    b.trigger(1, 0);
    // Emits in the first 0.5 s (fast) vs the window (1.0, 1.5] (slowed).
    let early = 0, late = 0, prev = 0;
    run(fast, a, 1.5, DT, (i) => {
      const n = fast.spray.emits.length;
      const t = (i + 1) * DT;
      if (t <= 0.5) early += n - prev;
      else if (t > 1.0) late += n - prev;
      prev = n;
    });
    expect(early).toBeGreaterThan(0);
    expect(early).toBeGreaterThan(late);
    // sprayScale 0 disables emission entirely.
    run(none, b, 1.5);
    expect(none.spray.emits).toHaveLength(0);
    // The throw is up and out of the crest, sizes and lives sane.
    for (const e of fast.spray.emits) {
      expect(e.vy).toBeGreaterThan(0);
      expect(e.size).toBeGreaterThan(0);
      expect(e.life).toBeGreaterThan(0);
      expect(e.drag).toBeGreaterThan(0);
      expect(Number.isFinite(e.x)).toBe(true);
    }
    // Nothing is thrown once the envelope collapses (env < SPRAY_ENV_MIN at ~t=2.1).
    run(fast, a, 0.9); // t ≈ 2.4 — the fall is over
    const beforeTail = fast.spray.emits.length;
    run(fast, a, 0.2);
    expect(fast.spray.emits.length).toBe(beforeTail);
  });

  it("strand count never exceeds the pool", () => {
    const h = makeCtx();
    const s = new Sweep(h.ctx);
    s.trigger(1, 0);
    run(h, s, 3.0);
    expect(new Set(h.water.acquired).size).toBe(h.water.acquired.length);
    for (const handle of h.water.acquired) {
      expect(handle).toBeGreaterThanOrEqual(0);
      expect(handle).toBeLessThan(h.water.poolSize);
    }
    expect(h.water.liveSlots()).toBe(0);
  });
});

// ===========================================================================
describe("Bloom", () => {
  it("trigger sets active and acquires a strand; a recast keeps it", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    expect(b.active).toBe(false);
    b.trigger(1, 2, 3);
    expect(b.active).toBe(true);
    expect(b.strand).toBeGreaterThanOrEqual(0);
    expect(h.water.acquired).toHaveLength(1);
    b.trigger(4, 5, 6);
    expect(h.water.acquired).toHaveLength(1);
    expect(b.x).toBe(4);
    expect(b.y).toBe(5);
    expect(b.z).toBe(6);
  });

  it("before the burst the column is silent: alpha 0, count 0, no lights, no brushes", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    run(h, b, 0.05); // t < BURST_AT
    expect(h.deform.brushes).toHaveLength(0);
    expect(h.spray.emits).toHaveLength(0);
    expect(h.lights.count).toBe(0);
    const last = h.water.params.at(-1);
    expect(last).toBeDefined();
    expect(last!.alpha).toBe(0);
    expect(last!.count).toBe(0);
  });

  it("the burst fires exactly once: crater + ring brushes, trauma, 430 grains", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 2, 3);
    run(h, b, 0.2); // past BURST_AT (0.10 s), before the fallout curtain ramps
    // One deep crater, four broken ring brushes — five, once.
    expect(h.deform.brushes).toHaveLength(5);
    expect(h.deform.brushes[0].depth).toBeGreaterThan(0);   // the crater cuts
    expect(h.deform.brushes[0].radius).toBeGreaterThan(h.deform.brushes[1].radius); // crater wider than a ring chunk
    for (let i = 1; i < 5; i++) {
      expect(h.deform.brushes[i].depth).toBe(0);            // ring throws mass, doesn't dig
      expect(h.deform.brushes[i].berm).toBeGreaterThan(0);
    }
    expect(h.rig.trauma).toBeGreaterThan(0);
    expect(h.spray.emits).toHaveLength(430);                // the ring of thrown snow
    // No re-fire later in the cast.
    run(h, b, 0.8);
    expect(h.deform.brushes).toHaveLength(5);
  });

  it("burst grain count scales with sprayScale", () => {
    const h = makeCtx({ sprayScale: 0.5 });
    const b = new Bloom(h.ctx);
    b.trigger(1, 2, 3);
    run(h, b, 0.2);
    expect(h.spray.emits).toHaveLength(215);
  });

  it("at peak the column declares two lights, crater low and head above it", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 2, 3);
    run(h, b, 0.7); // env == 1 between RISE and HOLD
    expect(h.lights.count).toBe(2);
    const craterIntensity = h.lights.col[3];
    const headIntensity = h.lights.col[7];
    expect(craterIntensity).toBeGreaterThan(headIntensity);
    expect(headIntensity).toBeGreaterThan(0);
    // Crater sits just above the ground; the head rides the column.
    expect(h.lights.pos[1]).toBeGreaterThan(2);
    expect(h.lights.pos[1]).toBeLessThan(h.lights.pos[5]);
    expect(h.lights.pos[0]).toBeCloseTo(1, 6);
    expect(h.lights.pos[2]).toBeCloseTo(3, 6);
  });

  it("full envelope peaks, then withdraws to zero columns/alpha", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    const alphas: number[] = [];
    run(h, b, 2.0, DT, () => {
      const last = h.water.params.at(-1);
      alphas.push(last ? last.alpha : 0);
    });
    expect(Math.max(...alphas)).toBeGreaterThan(0.8); // reached full strength
    const last = h.water.params.at(-1)!;
    expect(last.count).toBe(0);   // collapsed — nothing drawn
    expect(last.alpha).toBe(0);
  });

  it("the fallout curtain keeps emitting long past the column, scaled by sprayScale", () => {
    const a = makeCtx({ sprayScale: 1 });
    const b = makeCtx({ sprayScale: 0 });
    const sa = new Bloom(a.ctx);
    const sb = new Bloom(b.ctx);
    sa.trigger(1, 0, 3);
    sb.trigger(1, 0, 3);
    run(a, sa, 5.0);
    run(b, sb, 5.0);
    expect(a.spray.emits.length).toBeGreaterThan(430); // burst + curtain
    expect(b.spray.emits).toHaveLength(0);             // curtain respects sprayScale
    // The crater still lands even with spray disabled.
    expect(b.deform.brushes.length).toBeGreaterThan(0);
  });

  it("end-of-life releases its strand exactly once and deactivates", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    const strand = b.strand;
    run(h, b, 5.5); // LIFE + FALLOUT = 5.15 s
    expect(b.active).toBe(false);
    expect(h.water.released.filter(r => r === strand)).toHaveLength(1);
    expect(h.water.liveSlots()).toBe(0);
    expect(h.lights.count).toBe(0);
  });

  it("_end is idempotent and cancel() mid-fallout is clean", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    run(h, b, 1.0);
    b.cancel();
    expect(b.active).toBe(false);
    expect(h.water.released).toHaveLength(1);
    const columns = h.water.columns.length;
    const params = h.water.params.length;
    run(h, b, 1.5);
    expect(h.water.columns.length).toBe(columns);
    expect(h.water.params.length).toBe(params);
    b._end();
    expect(h.water.released).toHaveLength(1);
  });

  it("recast re-arms the burst: second cast craters again, same strand", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    run(h, b, 0.5); // burst fired
    const traumaAfterFirst = h.rig.trauma;
    b.trigger(7, 0, 8);
    expect(h.water.acquired).toHaveLength(1); // no strand leak
    run(h, b, 0.2);
    expect(h.deform.brushes).toHaveLength(10); // two bursts, five brushes each
    expect(h.rig.trauma).toBeGreaterThan(traumaAfterFirst);
  });

  it("pool exhausted: the crater still lands but no column is laid or lit", () => {
    const h = makeCtx();
    for (let i = 0; i < h.water.poolSize; i++) h.water.acquire();
    const b = new Bloom(h.ctx);
    b.trigger(1, 2, 3);
    expect(b.active).toBe(true);
    expect(b.strand).toBe(-1);
    run(h, b, 0.2);
    expect(h.deform.brushes).toHaveLength(5); // the burst happens regardless
    expect(h.water.columns).toHaveLength(0);  // but nothing renders
    expect(h.lights.count).toBe(0);
    expect(h.rig.trauma).toBeGreaterThan(0);
  });

  it("lights drop to zero after the end, and nothing updates afterwards", () => {
    const h = makeCtx();
    const b = new Bloom(h.ctx);
    b.trigger(1, 0, 3);
    run(h, b, 5.5);
    const columns = h.water.columns.length;
    h.lights.begin();
    b.update(DT);
    expect(h.lights.count).toBe(0);
    expect(h.water.columns.length).toBe(columns);
  });
});

// ===========================================================================
describe("Crystallize", () => {
  it("trigger lays the glaze immediately — one centre brush plus satellites, before any update", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    expect(c.active).toBe(true);
    expect(h.deform.brushes.length).toBe(4); // glaze + 3 satellites
    const [glaze, ...sats] = h.deform.brushes;
    expect(glaze.radius).toBeGreaterThan(Math.max(...sats.map(s => s.radius)));
    expect(glaze.pack).toBeGreaterThan(0);
    expect(glaze.ice).toBe(1); // glazing refreezes the surface
    for (const s of sats) {
      expect(s.radius).toBeGreaterThan(0);
      expect(s.depth).toBeGreaterThan(0);
    }
  });

  it("plants the full formation gradually over the plant window", () => {
    const h = makeCtx({ terrainH: -2 });
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 0.2);
    const plantedEarly = h.crystals.plants.length;
    expect(plantedEarly).toBeGreaterThan(0);
    expect(plantedEarly).toBeLessThan(34);
    run(h, c, 0.8); // well past PLANT_TIME
    expect(h.crystals.plants).toHaveLength(34);
    for (const p of h.crystals.plants) {
      expect(p.y).toBeCloseTo(-2 - 0.06, 6); // buried at the surface
      expect(p.height).toBeGreaterThan(0);
      expect(p.radius).toBeGreaterThan(0);
      expect(p.grow).toBeGreaterThanOrEqual(0.45);
      expect(p.grow).toBeLessThanOrEqual(1.0);
      expect(p.stand).toBeGreaterThanOrEqual(34); // stands at least STAND seconds
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.ax)).toBe(true);
    }
  });

  it("declares one light per frame while active — bright forming, ember afterwards", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 2, 3);
    const early: number[] = [], late: number[] = [];
    run(h, c, 2.0, DT, (i) => {
      const t = (i + 1) * DT;
      expect(h.lights.count).toBe(1);
      if (t < 0.5) early.push(lightIntensity(h));
      else if (t > 1.9) late.push(lightIntensity(h));
    });
    expect(Math.max(...early)).toBeGreaterThan(5);   // forming light
    expect(Math.max(...late)).toBeLessThan(1);       // ember floor
  });

  it("frost spray falls during the plant window and the tail, then stops", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 1.3); // past PLANT_TIME + FROST_TAIL = 1.25 s — frost has stopped
    const emitted = h.spray.emits.length;
    expect(emitted).toBeGreaterThan(0);
    run(h, c, 0.9); // t ≈ 2.2 — still no frost
    expect(h.spray.emits.length).toBe(emitted);
  });

  it("sprayScale 0 silences the frost but plants and glazes as normal", () => {
    const h = makeCtx({ sprayScale: 0 });
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 1.2);
    expect(h.spray.emits).toHaveLength(0);
    expect(h.crystals.plants.length).toBeGreaterThan(0);
    // 4 glaze brushes at trigger + one snow-push brush per even-indexed prism (17 of 34).
    expect(h.deform.brushes.length).toBe(4 + 17);
  });

  it("deactivates on its own after the last prism plus DRAIN_TIME; lights drop to zero", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 2.4); // just under PLANT_TIME + DRAIN_TIME = 2.45 s
    expect(c.active).toBe(true);
    run(h, c, 0.3);
    expect(c.active).toBe(false);
    expect(h.crystals.plants).toHaveLength(34); // the formation stands after the spell drains
    h.lights.begin();
    c.update(DT);
    expect(h.lights.count).toBe(0);
  });

  it("crystallize never touches the water body — crystals carry the effect", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 3.0);
    expect(h.water.acquired).toHaveLength(0);
    expect(h.water.columns).toHaveLength(0);
    expect(h.water.released).toHaveLength(0);
    expect(h.water.params).toHaveLength(0);
  });

  it("cancel() deactivates cleanly — planting and lights freeze at once", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 0.3);
    c.cancel();
    expect(c.active).toBe(false);
    const plants = h.crystals.plants.length;
    const brushes = h.deform.brushes.length;
    run(h, c, 1.0);
    expect(h.crystals.plants).toHaveLength(plants);
    expect(h.deform.brushes).toHaveLength(brushes);
    expect(h.lights.count).toBe(0);
  });

  it("no update after deactivation — state is frozen", () => {
    const h = makeCtx();
    const c = new Crystallize(h.ctx);
    c.trigger(1, 0, 3);
    run(h, c, 3.0);
    const plants = h.crystals.plants.length;
    const emits = h.spray.emits.length;
    const t = c.t;
    run(h, c, 1.0);
    expect(c.t).toBe(t);
    expect(h.crystals.plants).toHaveLength(plants);
    expect(h.spray.emits.length).toBe(emits);
  });
});

// ===========================================================================
describe("Vortex", () => {
  it("trigger acquires three strands and sets active", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    expect(v.active).toBe(false);
    v.trigger();
    expect(v.active).toBe(true);
    expect(h.water.acquired).toHaveLength(3);
    expect(new Set(v.strands).size).toBe(3);
    expect(v.strands.every(s => s >= 0)).toBe(true);
  });

  it("a recast acquires nothing new", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    v.trigger();
    expect(h.water.acquired).toHaveLength(3);
  });

  it("update before trigger is a complete no-op", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    h.lights.begin();
    v.update(DT);
    expect(h.water.columns).toHaveLength(0);
    expect(h.lights.count).toBe(0);
  });

  it("tracks the player — the column is theirs, not the world's", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    run(h, v, 0.2);
    expect(v.x).toBeCloseTo(h.controller.position.x, 6);
    expect(v.z).toBeCloseTo(h.controller.position.z, 6);
    h.controller.position.x = 9;
    h.controller.position.z = -7;
    run(h, v, 0.1);
    expect(v.x).toBeCloseTo(9, 6);
    expect(v.z).toBeCloseTo(-7, 6);
    expect(h.lights.pos[0]).toBe(9);
    expect(h.lights.pos[2]).toBe(-7);
  });

  it("envelope ramps, holds at full strength, fades — light and spin track it", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    const intensities: number[] = [];
    const spins: number[] = [];
    run(h, v, 4.65, DT, () => {
      intensities.push(v.active ? lightIntensity(h) : 0);
      spins.push(v.spin);
    });
    const peak = Math.max(...intensities);
    expect(peak).toBeCloseTo(9, 5); // full envelope during the hold
    const rampFrames = Math.ceil(0.55 / DT);
    for (let i = 1; i < rampFrames; i++) {
      expect(intensities[i] + 1e-9).toBeGreaterThanOrEqual(intensities[i - 1]);
    }
    for (let i = intensities.length - Math.ceil(1.1 / DT) + 1; i < intensities.length; i++) {
      if (intensities[i] === 0 && intensities[i - 1] === 0) continue;
      expect(intensities[i] - 1e-9).toBeLessThanOrEqual(intensities[i - 1]);
    }
    // Spin only ever winds up — it does not ease out with the envelope.
    for (let i = 1; i < spins.length; i++) {
      if (spins[i] === 0) continue;
      expect(spins[i]).toBeGreaterThanOrEqual(spins[i - 1]);
    }
  });

  it("lays three tube profiles, 64 columns per helix, 192 per frame", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    const frames = run(h, v, 0.5);
    expect(h.water.columns.length).toBe(192 * frames);
    expect(h.water.params.every(p => p.profile === PROFILE_TUBE)).toBe(true);
    expect(h.water.params.every(p => p.count === 64)).toBe(true);
  });

  it("strip ring grows while held, retreats while fading, brushes flip sign", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    const ring: number[] = [];
    run(h, v, 4.65, DT, () => ring.push(v.ring));
    const peak = Math.max(...ring);
    expect(peak).toBeGreaterThan(ring[0]);         // grows while held
    expect(peak).toBeLessThanOrEqual(3.1 + 1e-9);  // clamps at the ring max
    expect(ring[ring.length - 1]).toBeLessThan(peak); // retreats while fading
    // Hold brushes take snow away (positive depth); fade brushes give it back (negative).
    const depths = h.deform.brushes.map(b => b.depth);
    expect(depths.some(d => d > 0)).toBe(true);
    expect(depths.some(d => d < 0)).toBe(true);
    // Chronological: hold brushes come first, then the give-backs.
    const firstNegative = depths.findIndex(d => d < 0);
    expect(firstNegative).toBeGreaterThan(0);
    expect(depths.slice(0, firstNegative).every(d => d >= 0)).toBe(true);
    for (const b of h.deform.brushes) {
      expect(Number.isFinite(b.yaw)).toBe(true);
      expect(b.radius).toBeGreaterThan(0);
    }
  });

  it("grains are thrown only while the envelope is up, scaled by sprayScale", () => {
    const a = makeCtx({ sprayScale: 1 });
    const b = makeCtx({ sprayScale: 0 });
    const va = new Vortex(a.ctx);
    const vb = new Vortex(b.ctx);
    va.trigger();
    vb.trigger();
    run(a, va, 1.5);
    run(b, vb, 1.5);
    expect(a.spray.emits.length).toBeGreaterThan(0);
    expect(b.spray.emits).toHaveLength(0);
    for (const e of a.spray.emits) {
      expect(e.vy).toBeGreaterThan(0);     // launched upward
      expect(e.kind).toBe(0);              // grains, not clods
      expect(e.size).toBeGreaterThan(0);
      expect(e.life).toBeGreaterThan(0);
    }
    // Nothing is thrown after the end of the fade.
    run(a, va, 3.1); // t ≈ 4.6 — past the fade
    const beforeTail = a.spray.emits.length;
    run(a, va, 0.5);
    expect(a.spray.emits.length).toBe(beforeTail);
  });

  it("end-of-life releases all three strands exactly once", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    const strands = [...v.strands];
    run(h, v, 5.0); // RAMP+HOLD+FADE = 4.65 s
    expect(v.active).toBe(false);
    expect(v.strands).toEqual([-1, -1, -1]);
    for (const s of strands) {
      expect(h.water.released.filter(r => r === s)).toHaveLength(1);
    }
    expect(h.water.liveSlots()).toBe(0);
    expect(h.lights.count).toBe(0);
  });

  it("_end is idempotent and cancel() mid-cast is clean", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    run(h, v, 1.0);
    v.cancel();
    expect(v.active).toBe(false);
    expect(h.water.released).toHaveLength(3);
    const columns = h.water.columns.length;
    v._end();
    v.cancel();
    expect(h.water.released).toHaveLength(3); // no double release
    run(h, v, 1.0);
    expect(h.water.columns.length).toBe(columns);
  });

  it("pool exhaustion: runs on the strands it got, never exceeds the pool, releases exactly those", () => {
    const h = makeCtx();
    for (let i = 0; i < 6; i++) h.water.acquire(); // 2 slots free
    const v = new Vortex(h.ctx);
    v.trigger();
    expect(v.strands.filter(s => s >= 0)).toHaveLength(2);
    expect(v.strands).toContain(-1);
    expect(h.water.acquired.length).toBe(8); // never beyond the pool
    const frames = run(h, v, 0.5);
    expect(h.water.columns.length).toBe(128 * frames); // 2 helices × 64
    run(h, v, 5.0);
    expect(h.water.released).toHaveLength(2); // only what it acquired
    expect(h.water.liveSlots()).toBe(6);      // external handles untouched
  });

  it("strand count never exceeds the pool across a full cast", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    run(h, v, 5.0);
    expect(new Set(h.water.acquired).size).toBe(h.water.acquired.length);
    for (const handle of h.water.acquired) {
      expect(handle).toBeGreaterThanOrEqual(0);
      expect(handle).toBeLessThan(h.water.poolSize);
    }
  });

  it("no update after active=false — nothing is written", () => {
    const h = makeCtx();
    const v = new Vortex(h.ctx);
    v.trigger();
    run(h, v, 5.0);
    const columns = h.water.columns.length;
    const params = h.water.params.length;
    h.lights.begin();
    v.update(DT);
    expect(v.active).toBe(false);
    expect(h.water.columns.length).toBe(columns);
    expect(h.water.params.length).toBe(params);
    expect(h.lights.count).toBe(0);
  });
});
