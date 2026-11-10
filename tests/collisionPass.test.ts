import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three";
import { S } from "../src/core/settings.js";
import { input } from "../src/core/input.js";
import { CollisionPass, emitBurnTrail } from "../src/physics/collisionPass.js";
import { CharacterController } from "../src/character/controller.js";
import type { CapsuleOwner } from "../src/physics/colliders.js";

/**
 * B1 — physics/collisionPass.ts. The pass is driven through its public
 * surface: `update()` with fixed dt steps against a parked-wreck capsule
 * (the only capsule `_rebuildPool` ever arms), or with pool slots armed by
 * hand and `_sweepWorld` called directly (the seam for machine-kind
 * capsules and stumble owners). Determinism: fixed dt; Math.random stubbed
 * where counts depend on jitter.
 */

const S_KEYS = [
  "collisions", "speeder", "impactHit", "impactCrash",
  "impactBounce", "impactSpin", "burnBackZ", "burnY",
] as const;

let savedS: Record<string, unknown> = {};
let savedRise = 1;

beforeEach(() => {
  savedS = {};
  for (const k of S_KEYS) savedS[k] = (S as unknown as Record<string, unknown>)[k];
  savedRise = input.riseLevel;
});

afterEach(() => {
  for (const k of S_KEYS) (S as unknown as Record<string, unknown>)[k] = savedS[k];
  input.riseLevel = savedRise;
  vi.restoreAllMocks();
});

type FakeCtl = ReturnType<typeof makeFakeCtl>;

function makeFakeCtl() {
  const calls: Array<{ vx: number, vz: number, spin: number, scrambleSec: number }> = [];
  const ctl = {
    position: new THREE.Vector3(0, 2, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    facing: 0,
    surf: 1,
    crashing: false,
    crashLanded: false,
    terrainSlam: null as null | { closing: number, nx: number, nz: number },
    beginCrashCalls: 0,
    endCrashCalls: 0,
    calls,
    applyImpact(vx: number, vz: number, spin: number, scrambleSec: number) {
      calls.push({ vx, vz, spin, scrambleSec });
      this.velocity.x = vx;
      this.velocity.z = vz;
    },
    beginCrash(_spinDir?: number) { this.beginCrashCalls++; },
    endCrash() { this.endCrashCalls++; },
  };
  return ctl;
}

function makeCounter() {
  const calls: unknown[][] = [];
  return {
    calls,
    get count() { return calls.length; },
    emit(...args: unknown[]) { calls.push(args); },
  };
}

function makeRig() {
  return { trauma: 0, addTrauma(t: number) { this.trauma += t; } };
}

interface AudioPlay { key: string, opts: { gain: number, rate: number, delay: number } }

function makeAudio() {
  const plays: AudioPlay[] = [];
  return { plays, play(key: string, opts: AudioPlay["opts"]) { plays.push({ key, opts }); } };
}

function makeTerrain() {
  const brushes: unknown[][] = [];
  return {
    brushes,
    heightAt: () => 1.5,
    normalAt: (_x: number, _z: number, out: THREE.Vector3) => out.set(0, 1, 0),
    deform: { brush: (...args: unknown[]) => { brushes.push(args); } },
  };
}

interface HarnessOver {
  ctl?: FakeCtl;
  speeder?: { position: THREE.Vector3 } | null;
  parked?: (() => { x: number, y: number, z: number } | null) | null;
  terrain?: ReturnType<typeof makeTerrain> | null;
  spray?: ReturnType<typeof makeCounter>;
  smoke?: ReturnType<typeof makeCounter>;
  rig?: ReturnType<typeof makeRig>;
  audio?: ReturnType<typeof makeAudio>;
}

function makeHarness(over: HarnessOver = {}) {
  const ctl = over.ctl ?? makeFakeCtl();
  const speeder = "speeder" in over
    ? over.speeder ?? null
    : { position: new THREE.Vector3(ctl.position.x, 2, ctl.position.z) };
  const spray = over.spray ?? makeCounter();
  const smoke = over.smoke ?? makeCounter();
  const rig = over.rig ?? makeRig();
  const audio = over.audio ?? makeAudio();
  const terrain = over.terrain ?? null;
  // CollisionCtx is structurally satisfied by the fakes; it is not exported.
  const ctx = {
    character: ctl,
    speeder,
    parked: over.parked ?? null,
    terrain,
    spray,
    smoke,
    rig,
    audio,
  } as unknown as ConstructorParameters<typeof CollisionPass>[0];
  const pass = new CollisionPass(ctx);
  return { pass, ctl, speeder, spray, smoke, rig, audio, terrain };
}
/** Prime a pass so the slot's prev position is recorded (first frame never sweeps). */
function prime(pass: CollisionPass) {
  pass.update(1 / 30);
}

/** Narrow to a present speeder (two tests construct one deliberately without). */
function sp(h: ReturnType<typeof makeHarness>): { position: THREE.Vector3 } {
  if (!h.speeder) throw new Error("harness has no speeder");
  return h.speeder;
}

/** Move the craft to (x, y, z) and run one frame. */
function flyTo(h: ReturnType<typeof makeHarness>, x: number, y: number, z: number) {
  h.ctl.position.set(x, y, z);
  sp(h).position.set(x, y, z);
  h.pass.update(1 / 30);
}

/** Parked wreck at (0, y=2, z=8): capsule y 1..4, radius 2, reach 3.6. */
const PARKED = () => ({ x: 0, y: 2, z: 8 });

describe("construction", () => {
  it("works with an all-optional empty ctx", () => {
    const pass = new CollisionPass({});
    expect(pass.pool.length).toBe(8);
    expect(pass.slots.length).toBe(1);
    expect(pass.slots[0].wing).toBeNull();
    expect(pass.lastImpact).toEqual({ kind: "", severity: "", normalSpeed: 0, spin: 0, player: false });
    expect(pass._pDamage).toBe(0);
    expect(pass._pBurnT).toBe(0);
    expect(pass._pRecover).toBe(0);
  });

  it("sizes the capsule pool +1 when a parked hook is present", () => {
    expect(new CollisionPass({ parked: PARKED }).pool.length).toBe(9);
    expect(new CollisionPass({}).pool.length).toBe(8);
  });

  it("arms the parked wreck slot as kind 'wreck' hanging PARKED_LO..PARKED_HI from the hook point", () => {
    const { pass } = makeHarness({ parked: PARKED });
    prime(pass);
    const c = pass.pool[0];
    expect(c.live).toBe(true);
    expect(c.kind).toBe("wreck");
    expect(c.ax).toBe(0);
    expect(c.ay).toBe(1);   // 2 - PARKED_LO
    expect(c.by).toBe(4);   // 2 + PARKED_HI
    expect(c.r).toBe(2);    // PARKED_R
    expect(c.owner).toBeNull();
  });

  it("disarms the parked slot when the hook reports no craft left behind", () => {
    const { pass } = makeHarness({ parked: () => null });
    prime(pass);
    expect(pass.pool[0].live).toBe(false);
  });
});

describe("update() guards", () => {
  it("freeze-time (dt = 0) never sweeps — no contact even overlapping a capsule", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.position.set(0, 2, 6);
    sp(h).position.set(0, 2, 6);
    h.ctl.velocity.set(0, 0, 20);
    h.pass.update(0);
    expect(h.ctl.calls.length).toBe(0);
    expect(h.pass.lastImpact.severity).toBe("");
  });

  it("S.collisions=false forgets prev positions; re-enabling does not sweep a teleport", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);                       // has = true at z=0
    S.collisions = false;
    h.ctl.position.set(0, 2, 200);       // far past the wreck
    sp(h).position.set(0, 2, 200);
    h.pass.update(1 / 30);
    expect(h.ctl.calls.length).toBe(0);
    S.collisions = true;
    h.pass.update(1 / 30);               // re-primes at z=200, no motion → no sweep across the field
    expect(h.ctl.calls.length).toBe(0);
    expect(h.pass.slots[0].has).toBe(true);
    expect(h.pass.slots[0].prevZ).toBe(200);
  });

  it("clamps dt to 1/30 s for the recovery clock", () => {
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    h.ctl.crashLanded = true;
    h.ctl.position.set(3, 2, 4);
    h.pass.update(10);                   // absurd dt; must clamp to 1/30
    expect(h.pass._pRecover).toBeCloseTo(9 - 1 / 30, 6);
  });

  it("dt = 0 consumes a crash landing but spends no recovery time", () => {
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    h.ctl.crashLanded = true;
    h.pass.update(0);
    expect(h.ctl.crashLanded).toBe(false);
    expect(h.pass._pRecover).toBe(9);
  });
});

describe("sweep outcomes vs the pool (parked wreck, kind 'wreck')", () => {
  // Capsule (0,1..4,8), r=2; craft y=2 → dy=0, reach=3.6, contact at z=4.4.
  const runContact = (closing: number) => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, closing);
    flyTo(h, 0, 2, 6);                   // 6 m step (< TELEPORT), crosses the reach boundary
    return h;
  };

  it("scrape: severity, scramble 0, spray dusting, no smoke, no report", () => {
    const h = runContact(3);
    expect(h.pass.lastImpact.severity).toBe("scrape");
    expect(h.pass.lastImpact.kind).toBe("wreck");
    expect(h.pass.lastImpact.player).toBe(true);
    expect(h.pass.lastImpact.normalSpeed).toBeCloseTo(3, 1);
    expect(h.ctl.calls.length).toBe(1);
    expect(h.ctl.calls[0].scrambleSec).toBe(0);
    expect(h.spray.count).toBe(4);       // SPRAY_BY_SEVERITY.scrape
    expect(h.smoke.count).toBe(0);
    expect(h.audio.plays.length).toBe(0);
  });

  it("scrape trauma scales with closing speed but is floored at SCRAPE_TRAUMA_FLOOR", () => {
    const slow = runContact(3);
    expect(slow.rig.trauma).toBeCloseTo(0.12 * (3 / 7), 4);
    const creep = runContact(0.5);
    expect(creep.rig.trauma).toBeCloseTo(0.12 * 0.15, 4);   // floor: barely-closing graze still registers
  });

  it("hit: severity, scramble 0.9, TRAUMA.hit, 3 smoke puffs, speederCrash report", () => {
    const h = runContact(10);
    expect(h.pass.lastImpact.severity).toBe("hit");
    expect(h.ctl.calls[0].scrambleSec).toBe(0.9);
    expect(h.rig.trauma).toBeCloseTo(0.35, 4);
    expect(h.spray.count).toBe(6);
    expect(h.smoke.count).toBe(3);       // HIT_PUFFS
    const hullPlays = h.audio.plays.filter((p: { key: string }) => p.key === "speederCrash");
    expect(hullPlays.length).toBe(1);
    expect(hullPlays[0].opts.rate).toBeCloseTo(1.1, 6);
    expect(hullPlays[0].opts.gain).toBeGreaterThan(0.2);
    expect(hullPlays[0].opts.gain).toBeLessThanOrEqual(0.25);
  });

  it("crash: severity, scramble 2.0, ladder trips outright, controller told to beginCrash", () => {
    const h = runContact(20);
    expect(h.pass.lastImpact.severity).toBe("crash");
    expect(h.ctl.calls[0].scrambleSec).toBe(2.0);
    expect(h.rig.trauma).toBeCloseTo(0.9 + 1.0, 4);   // TRAUMA.crash + _trip()'s addTrauma(1)
    expect(h.spray.count).toBe(10);
    expect(h.pass._pDamage).toBe(3);
    expect(h.pass._pBurnT).toBe(20);                  // PLAYER_BURN
    expect(h.ctl.beginCrashCalls).toBe(1);
  });

  it("depenetrates the craft planar to axis ± (need + EASE_OUT)", () => {
    const h = runContact(10);
    // need = sqrt(3.6² − 0²) = 3.6; pushed out to 3.65 from axis → z = 8 − 3.65
    expect(h.ctl.position.z).toBeCloseTo(4.35, 5);
  });

  it("leaves the corridor alone when the craft clears the capsule vertically", () => {
    const h = makeHarness({ parked: PARKED });
    h.ctl.position.set(0, 10, 0);
    sp(h).position.set(0, 10, 0);
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 20);
    flyTo(h, 0, 10, 6);                // over the top: dy = 10−4 = 6 > reach
    expect(h.ctl.calls.length).toBe(0);
    expect(h.pass.lastImpact.severity).toBe("");
  });

  it("rewrites lastImpact on every contact", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 3);
    flyTo(h, 0, 2, 6);
    expect(h.pass.lastImpact.severity).toBe("scrape");
    const normalSpeed1 = h.pass.lastImpact.normalSpeed;
    // re-place and strike harder
    h.ctl.position.set(0, 2, 0);
    sp(h).position.set(0, 2, 0);
    h.pass.update(1 / 30);             // re-prime at origin
    h.ctl.velocity.set(0, 0, 10);
    flyTo(h, 0, 2, 6);
    expect(h.pass.lastImpact.severity).toBe("hit");
    expect(h.pass.lastImpact.normalSpeed).not.toBe(normalSpeed1);
    expect(h.pass.lastImpact.kind).toBe("wreck");
  });

  it("scrape fx are rate-limited per craft (fxT); applyImpact still lands every contact", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 3);
    flyTo(h, 0, 2, 6);
    expect(h.spray.count).toBe(4);
    expect(h.rig.trauma).toBeGreaterThan(0);
    const traumaAfterFirst = h.rig.trauma;
    // immediate second contact while fxT is still running
    h.ctl.position.set(0, 2, 4.4);     // 3.6 from axis: inside reach
    sp(h).position.copy(h.ctl.position);
    h.ctl.velocity.set(0, 0, 3);
    h.pass.update(1 / 30);
    expect(h.ctl.calls.length).toBe(2);          // response is never rate-limited
    expect(h.spray.count).toBe(4);               // fx are
    expect(h.rig.trauma).toBe(traumaAfterFirst);
    // let the window run out, then the next scrape speaks again
    for (let i = 0; i < 8; i++) {
      h.ctl.position.set(0, 2, 0);
      sp(h).position.set(0, 2, 0);
      h.pass.update(1 / 30);
    }
    h.ctl.velocity.set(0, 0, 3);
    flyTo(h, 0, 2, 6);
    expect(h.spray.count).toBe(8);
  });
});

describe("sweep outcomes — machine capsules via armed pool slots (_sweepWorld)", () => {
  const armLeg = (pass: CollisionPass, owner: CapsuleOwner | null) => {
    const c = pass.pool[4];
    c.ax = 0; c.ay = 0; c.az = 8;
    c.bx = 0; c.by = 10; c.bz = 8;
    c.r = 1;
    c.kind = "leg";
    c.owner = owner;
    c.live = true;
  };
  const poseSlot = (pass: CollisionPass) => {
    const s = pass.slots[0];
    s.has = true; s.active = true;
    s.prevX = 0; s.prevY = 2; s.prevZ = 2;
    s.cx = 0; s.cy = 2; s.cz = 6;
    s.mx = 0; s.my = 0; s.mz = 4;
    return s;
  };

  it("hull-kind crash: speederHitModel report at full gain; owner.stumble called with normalSpeed/25 and a side", () => {
    const stumbles: Array<{ speed: number, side: number }> = [];
    const pose = {
      position: { x: 0, y: 0, z: 8 },
      yaw: 0.3,
      stumble(speed: number, side: number) { stumbles.push({ speed, side }); },
    };
    const h = makeHarness();
    armLeg(h.pass, pose);
    const slot = poseSlot(h.pass);
    h.ctl.velocity.set(0, 0, 20);
    h.pass._sweepWorld(slot);
    expect(h.pass.lastImpact.kind).toBe("leg");
    expect(h.pass.lastImpact.severity).toBe("crash");
    const hull = h.audio.plays.find((p: { key: string }) => p.key === "speederHitModel");
    expect(hull).toBeDefined();
    expect(hull!.opts.gain).toBeGreaterThan(0);
    expect(stumbles.length).toBe(1);
    expect(stumbles[0].speed).toBeCloseTo(h.pass.lastImpact.normalSpeed / 25, 4);
    expect([-1, 1]).toContain(stumbles[0].side);
  });

  it("hull-kind hit: speederHitModel at partial gain (HULL_SFX_GAIN.hit)", () => {
    const pose = { position: { x: 0, y: 0, z: 8 }, yaw: 0, stumble() { } };
    const h = makeHarness();
    armLeg(h.pass, pose);
    const slot = poseSlot(h.pass);
    h.ctl.velocity.set(0, 0, 10);
    h.pass._sweepWorld(slot);
    expect(h.pass.lastImpact.severity).toBe("hit");
    const hull = h.audio.plays.find((p: { key: string }) => p.key === "speederHitModel");
    expect(hull).toBeDefined();
    // distance is small, so near ≈ 1 and gain ≈ 0.45 from below
    expect(hull!.opts.gain).toBeGreaterThan(0.4);
    expect(hull!.opts.gain).toBeLessThanOrEqual(0.45);
  });

  it("scrape into a machine: silent — the snow is the scrape", () => {
    const pose = { position: { x: 0, y: 0, z: 8 }, yaw: 0, stumble() { } };
    const h = makeHarness();
    armLeg(h.pass, pose);
    const slot = poseSlot(h.pass);
    h.ctl.velocity.set(0, 0, 3);
    h.pass._sweepWorld(slot);
    expect(h.pass.lastImpact.severity).toBe("scrape");
    expect(h.audio.plays.length).toBe(0);
  });

  it("spin kick scales with S.impactSpin", () => {
    // probe spin through the leg seam where the geometry is known
    const runLeg = (impactSpin: number) => {
      S.impactSpin = impactSpin;
      const h = makeHarness();
      armLeg(h.pass, null);
      const slot = poseSlot(h.pass);
      h.ctl.velocity.set(0, 0, 20);
      h.ctl.facing = Math.PI / 2;        // lever arm off-axis
      h.pass._sweepWorld(slot);
      return h.ctl.calls[0].spin;
    };
    const s1 = runLeg(1);
    const s2 = runLeg(2);
    expect(s2).toBeCloseTo(s1 * 2, 6);
    expect(Number.isFinite(s1)).toBe(true);
  });
});

describe("player damage ladder", () => {
  const hitOnce = (h: ReturnType<typeof makeHarness>) => {
    h.ctl.position.set(0, 2, 0);
    sp(h).position.set(0, 2, 0);
    h.pass.update(1 / 30);               // re-prime
    h.ctl.velocity.set(0, 0, 10);        // closing 10 → 'hit'
    flyTo(h, 0, 2, 6);
  };
  const parkFar = (h: ReturnType<typeof makeHarness>, frames: number) => {
    for (let i = 0; i < frames; i++) {
      h.ctl.position.set(0, 2, 0);
      sp(h).position.set(0, 2, 0);
      h.pass.update(1 / 30);
    }
  };

  it("'hit' steps the ladder inside grace; further hits inside the window do not", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 10);
    flyTo(h, 0, 2, 6);
    expect(h.pass._pDamage).toBe(1);
    expect(h.pass._pGrace).toBeGreaterThan(0);
    hitOnce(h);                          // inside grace
    expect(h.pass._pDamage).toBe(1);
  });

  it("ladder trips on the third rung after grace expires; burn runs, then field repair resets it", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 10);
    flyTo(h, 0, 2, 6);
    expect(h.pass._pDamage).toBe(1);
    parkFar(h, 130);                     // > 4 s of grace
    expect(h.pass._pGrace).toBe(0);
    hitOnce(h);
    expect(h.pass._pDamage).toBe(2);
    parkFar(h, 130);
    hitOnce(h);
    expect(h.pass._pDamage).toBe(3);     // tripped
    expect(h.pass._pBurnT).toBeGreaterThan(0);
    expect(h.pass._pBurnT).toBeLessThanOrEqual(20);
    expect(h.ctl.beginCrashCalls).toBe(1);
    parkFar(h, 620);                     // > 20 s of burn
    expect(h.pass._pBurnT).toBe(0);
    expect(h.pass._pDamage).toBe(0);
  });

  it("'crash' trips the ladder outright, once, and starts the burn", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 20);
    flyTo(h, 0, 2, 6);
    expect(h.pass._pDamage).toBe(3);
    expect(h.pass._pBurnT).toBeGreaterThan(19);
    expect(h.ctl.beginCrashCalls).toBe(1);
  });

  it("while the burn runs, further crashes are already part of the fire (no re-trip)", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 20);
    flyTo(h, 0, 2, 6);
    const begins = h.ctl.beginCrashCalls;
    hitOnce(h);                          // burn active now; a 'hit' must not step the ladder
    expect(h.pass._pDamage).toBe(3);
    expect(h.ctl.beginCrashCalls).toBe(begins);
  });
});

describe("_playerCrash — runs above both guards", () => {
  const landCrash = (h: ReturnType<typeof makeHarness>) => {
    h.ctl.crashLanded = true;
    h.ctl.position.set(3, 2, 4);
    sp(h).position.set(3, 2, 4);
    h.ctl.facing = 0;
  };

  it("consumes the landing with collisions OFF, scars the terrain, throws snow and starts RECOVER", () => {
    S.collisions = false;
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    landCrash(h);
    h.pass.update(1 / 30);
    expect(h.ctl.crashLanded).toBe(false);
    expect(h.pass._pRecover).toBeCloseTo(9 - 1 / 30, 6);
    expect(terrain.brushes.length).toBe(2);      // crater + furrow
    expect(terrain.brushes[0]).toEqual([3, 4, 3.4, 0.85, 0.6, 1.0, 0.6, 0, 1.3, 1.0]);
    expect(terrain.brushes[1][0]).toBeCloseTo(3, 6);   // facing 0 → behind is −z
    expect(terrain.brushes[1][1]).toBeCloseTo(4 - 4.5, 6);
    expect(terrain.brushes[1][2]).toBe(2.4);
    expect(h.spray.count).toBe(60);              // CRASH_SPLASH.COUNT
    expect(h.smoke.count).toBe(10);              // CRASH_SMOKE.COUNT
    expect(h.rig.trauma).toBe(1);
    expect(h.ctl.endCrashCalls).toBe(0);
  });

  it("after RECOVER seconds the craft is handed back: endCrash, zeroed velocity, riseLevel restored, ladder clear", () => {
    S.collisions = false;
    input.riseLevel = 1;
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    landCrash(h);
    for (let i = 0; i < 280 && h.ctl.endCrashCalls === 0; i++) h.pass.update(1 / 30);
    expect(h.ctl.endCrashCalls).toBe(1);
    expect(h.ctl.velocity.length()).toBe(0);
    expect(input.riseLevel).toBe(3);
    expect(h.pass._pDamage).toBe(0);
    expect(h.pass._pBurnT).toBe(0);
    expect(h.pass._pGrace).toBe(4);              // PLAYER_GRACE re-armed
    expect(h.pass._pRecover).toBe(0);
    // and it does not fire twice
    for (let i = 0; i < 10; i++) h.pass.update(1 / 30);
    expect(h.ctl.endCrashCalls).toBe(1);
  });

  it("a crash interrupted by the overlay toggle still reaches the ground and hands the craft back", () => {
    // Mirror of the shipped bug: collisions switched off mid-crash must not strand the player.
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    landCrash(h);
    S.collisions = false;                // overlay toggled off at the moment of landing
    for (let i = 0; i < 280 && h.ctl.endCrashCalls === 0; i++) h.pass.update(1 / 30);
    expect(h.ctl.endCrashCalls).toBe(1);
    expect(input.riseLevel).toBe(3);
  });

  it("does not run for a controller that never landed", () => {
    const terrain = makeTerrain();
    const h = makeHarness({ terrain });
    h.pass.update(1 / 30);
    expect(terrain.brushes.length).toBe(0);
    expect(h.pass._pRecover).toBe(0);
  });
});

describe("terrain-slam path", () => {
  it("hit-strength slam: applies velocity response, scramble 0.9, trauma, consumes the slam", () => {
    const h = makeHarness();
    h.ctl.velocity.set(12, 0, 0);
    h.ctl.terrainSlam = { closing: 10, nx: 1, nz: 0 };
    prime(h.pass);
    h.pass.update(1 / 30);
    expect(h.ctl.terrainSlam).toBeNull();
    expect(h.ctl.calls.length).toBe(1);
    expect(h.ctl.calls[0].scrambleSec).toBe(0.9);
    expect(h.rig.trauma).toBeCloseTo(0.35, 4);
    expect(h.spray.count).toBe(6);
    expect(h.smoke.count).toBe(3);
    expect(h.pass._pDamage).toBe(0);      // only crash slams join the ladder (_terrainSlam: crash trips, hit does not)
  });

  it("scrape-strength slam: fx only, no applyImpact", () => {
    const h = makeHarness();
    h.ctl.velocity.set(3, 0, 0);
    h.ctl.terrainSlam = { closing: 3, nx: 1, nz: 0 };
    prime(h.pass);
    h.pass.update(1 / 30);
    expect(h.ctl.terrainSlam).toBeNull();
    expect(h.ctl.calls.length).toBe(0);
    expect(h.rig.trauma).toBeCloseTo(0.12 * (3 / 7), 4);
    expect(h.pass._pDamage).toBe(0);
  });

  it("crash-strength slam: applies response, trips the ladder", () => {
    const h = makeHarness();
    h.ctl.velocity.set(25, 0, 0);
    h.ctl.terrainSlam = { closing: 20, nx: 1, nz: 0 };
    prime(h.pass);
    h.pass.update(1 / 30);
    expect(h.ctl.calls.length).toBe(1);
    expect(h.ctl.calls[0].scrambleSec).toBe(2.0);
    expect(h.pass._pDamage).toBe(3);
    expect(h.pass._pBurnT).toBeGreaterThan(19);
    expect(h.ctl.beginCrashCalls).toBe(1);
  });

  it("ignores the slam when the speeder is absent or S.speeder is off (slam NOT consumed)", () => {
    const h = makeHarness({ speeder: null });
    h.ctl.terrainSlam = { closing: 20, nx: 1, nz: 0 };
    prime(h.pass);
    h.pass.update(1 / 30);
    expect(h.ctl.terrainSlam).not.toBeNull();
    expect(h.ctl.calls.length).toBe(0);

    const h2 = makeHarness();
    h2.ctl.terrainSlam = { closing: 20, nx: 1, nz: 0 };
    S.speeder = false;
    prime(h2.pass);
    h2.pass.update(1 / 30);
    expect(h2.ctl.terrainSlam).not.toBeNull();
    expect(h2.ctl.calls.length).toBe(0);
  });
});

describe("control scramble & impact spin (via controller.applyImpact)", () => {
  it("hit contact maps to SCRAMBLE.hit seconds and spin scaled by S.impactSpin", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 10);
    flyTo(h, 0, 2, 6);
    expect(h.ctl.calls[0].scrambleSec).toBe(0.9);
    expect(Number.isFinite(h.ctl.calls[0].spin)).toBe(true);
    expect(h.ctl.calls[0].spin).toBe(0);  // dead-centre head-on: zero lever arm
  });

  it("real CharacterController: hit sets scramble (0.9) and _scrambleMax; weaker re-scrambles never shorten it; a crash hands off via beginCrash (scramble reset)", () => {
    const terrain = { heightAt: () => 0, normalAt: (_x: number, _z: number, out: THREE.Vector3) => out.set(0, 1, 0) };
    const c = new CharacterController(terrain);
    c.surf = 1;
    c.position.set(0, 2, 0);
    c.velocity.set(0, 0, 10);
    const speeder = { position: new THREE.Vector3(0, 2, 0) };
    // CollisionCtx is structural and not exported; the fakes satisfy it.
    const ctx = { character: c, speeder, parked: PARKED } as unknown as ConstructorParameters<typeof CollisionPass>[0];
    const pass = new CollisionPass(ctx);
    pass.update(1 / 30);                 // prime
    c.position.set(0, 2, 6);
    speeder.position.set(0, 2, 6);
    pass.update(1 / 30);                 // hit: closing 10
    expect(c.controlScramble).toBeCloseTo(0.9, 6);
    expect(c._scrambleMax).toBeCloseTo(0.9, 6);
    // a later weaker scramble does not shorten or re-base the max
    c.applyImpact(0, 0, 0, 0.5);
    expect(c.controlScramble).toBeCloseTo(0.9, 6);
    expect(c._scrambleMax).toBeCloseTo(0.9, 6);
    // a crash-strength contact applies 2.0, but the crash sequence then takes
    // the controls away — beginCrash() zeroes scramble and spin by design
    c.position.set(0, 2, 0);
    speeder.position.set(0, 2, 0);
    pass.update(1 / 30);                 // re-prime
    c.velocity.set(0, 0, 20);
    c.position.set(0, 2, 6);
    speeder.position.set(0, 2, 6);
    pass.update(1 / 30);                 // crash: trips ladder → beginCrash
    expect(c.crashing).toBe(true);
    expect(c.controlScramble).toBe(0);
    expect(c._scrambleMax).toBe(0);
  });
});

describe("burn trail off a damaged hull (_ladderUpkeep)", () => {
  it("emits smoke-only puffs once the ladder is at rung ≥ 1, and no fire row below TRAIL_FIRE_RUNG", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.ctl.velocity.set(0, 0, 10);
    flyTo(h, 0, 2, 6);                   // hit → _pDamage = 1
    expect(h.pass._pDamage).toBe(1);
    h.smoke.calls.length = 0;
    h.ctl.position.set(0, 2, 0);         // far, no contact; just upkeep
    sp(h).position.set(0, 2, 0);
    h.pass.update(1 / 30);
    expect(h.smoke.count).toBe(1);       // one smoke row per puff, no fire row
    expect(h.smoke.calls[0][9]).toBeCloseTo(0.09, 6);   // TRAIL_SMOKE.TINT (smoke-only)
  });

  it("lights the fire row at TRAIL_FIRE_RUNG (damage ≥ 2)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.pass._pDamage = 2;                 // pretend two rungs taken
    h.ctl.position.set(0, 2, 0);
    sp(h).position.set(0, 2, 0);
    h.pass.update(1 / 30);
    expect(h.smoke.count).toBe(2);       // smoke row + fire row
    expect(h.smoke.calls[0][9]).toBeCloseTo(0.045, 6);  // TINT_WITH_FIRE
    expect(h.smoke.calls[1][9]).toBeCloseTo(3.2, 6);    // FIRE_TINT.R
    expect(h.smoke.calls[1][13]).toBe(false);           // fire row is not buoyant
  });

  it("stops emitting while the crash sequence owns the frame", () => {
    const h = makeHarness({ parked: PARKED });
    prime(h.pass);
    h.pass._pDamage = 2;
    h.ctl.crashing = true;
    h.ctl.position.set(0, 2, 0);
    sp(h).position.set(0, 2, 0);
    h.pass.update(1 / 30);
    expect(h.smoke.count).toBe(0);
  });
});

describe("emitBurnTrail (export) — argument edges", () => {
  type EmitArgs = [
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, grow: number, life: number,
    r: number, g: number, b: number,
    a: number, buoyant: boolean,
  ];
  const sink = () => {
    const calls: EmitArgs[] = [];
    return { calls, emit: (...a: EmitArgs) => { calls.push(a); } };
  };

  it("places the puff BURN_BACK behind the tail, at hull height + BURN_LIFT, honouring S.burnBackZ / S.burnY", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    S.burnBackZ = 2.4;
    S.burnY = 1.0;
    const smoke = sink();
    emitBurnTrail(smoke, { x: 1, y: 2, z: 3 }, 0, { x: 4, y: 0, z: 6 }, false, 0);
    expect(smoke.calls.length).toBe(1);
    const a = smoke.calls[0];
    expect(a[0]).toBeCloseTo(1, 6);          // facing 0 → back is −z, x unchanged
    expect(a[1]).toBeCloseTo(3.0, 6);        // 2 + burnY
    expect(a[2]).toBeCloseTo(0.6, 6);        // 3 − 2.4
    expect(a[3]).toBeCloseTo(4 * 0.22, 6);   // vel.x × TRAIL_SMOKE.DRIFT (+ zero jitter at random=0.5)
    expect(a[5]).toBeCloseTo(6 * 0.22, 6);   // vel.z × DRIFT
    expect(a[9]).toBeCloseTo(0.09, 6);       // smoke-only tint
    expect(a[12]).toBe(0.55);                // ALPHA
    expect(a[13]).toBe(true);                // buoyant
  });

  it("falls back to BURN_BACK_DEFAULT / BURN_LIFT_DEFAULT when S values are unset", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // S fields are typed number; the pass reads them with `??`, so unset = default
    const sUndef = S as unknown as { burnBackZ?: number, burnY?: number };
    sUndef.burnBackZ = undefined;
    sUndef.burnY = undefined;
    const smoke = sink();
    emitBurnTrail(smoke, { x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: 0 }, false, 0);
    expect(smoke.calls[0][1]).toBeCloseTo(0.95, 6);   // BURN_LIFT_DEFAULT
    expect(smoke.calls[0][2]).toBeCloseTo(-2.4, 6);   // BURN_BACK_DEFAULT
  });

  it("facing = π/2 drags the trail off the +x flank", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    S.burnBackZ = 2.4;
    S.burnY = 1.0;
    const smoke = sink();
    emitBurnTrail(smoke, { x: 0, y: 0, z: 0 }, Math.PI / 2, { x: 0, y: 0, z: 0 }, false, 0);
    expect(smoke.calls[0][0]).toBeCloseTo(-2.4, 6);   // back is −x now
    expect(smoke.calls[0][2]).toBeCloseTo(0, 6);
  });

  it("inherits the fall rate (vy) into the rise and dims the smoke tint when fire is lit", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    S.burnBackZ = 2.4;
    S.burnY = 1.0;
    const smoke = sink();
    emitBurnTrail(smoke, { x: 0, y: 0, z: 0 }, 0, { x: 0, y: 0, z: 0 }, true, -3);
    expect(smoke.calls.length).toBe(2);
    // smoke row: rise + 0.5×riseJitter + vy = 1.1 + 0.3 − 3 = −1.6
    expect(smoke.calls[0][4]).toBeCloseTo(-1.6, 6);
    expect(smoke.calls[0][9]).toBeCloseTo(0.045, 6);  // TINT_WITH_FIRE
    // fire row: rise + 0.5×riseJitter + vy = 0.9 + 0.4 − 3 = −1.7
    expect(smoke.calls[1][4]).toBeCloseTo(-1.7, 6);
    expect(smoke.calls[1][9]).toBeCloseTo(3.2, 6);    // FIRE_TINT.R
    expect(smoke.calls[1][10]).toBeCloseTo(1.05, 6);  // FIRE_TINT.G
    expect(smoke.calls[1][11]).toBeCloseTo(0.26, 6);  // FIRE_TINT.B
  });
});
