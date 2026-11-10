import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three";
import { CharacterController, RUN_SPEED } from "../src/character/controller.js";
import { input } from "../src/core/input.js";
import { S } from "../src/core/settings.js";
import type { CameraRig } from "../src/core/camera.js";

const DT = 1 / 30;

type TerrainStub = {
  heightAt: (x: number, z: number) => number;
  normalAt: (x: number, z: number, out: THREE.Vector3) => THREE.Vector3;
};

const flatTerrain = (): TerrainStub => ({
  heightAt: () => 0,
  normalAt: (_x, _z, out) => out.set(0, 1, 0),
});

function makeRig(yaw = 0) {
  const rig = {
    yaw,
    trauma: 0,
    getFlatForward(out: THREE.Vector3) {
      out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      return out;
    },
    getFlatRight(out: THREE.Vector3) {
      out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      return out;
    },
    addTrauma(n: number) {
      this.trauma = Math.min(1, this.trauma + n);
    },
  };
  return rig as unknown as CameraRig & { trauma: number };
}

const INPUT_KEYS = [
  "moveX", "moveZ", "moving", "flying", "surf", "fire", "sprint",
  "riseLevel", "thrust", "boost", "vert",
] as const;
const S_KEYS = [
  "flightThrottle", "speederClimbMax", "speederClimbRate",
  "speederClimbSpeed", "speederCeiling",
] as const;

const savedInput = new Map<string, unknown>();
const savedS = new Map<string, unknown>();

function resetGlobals() {
  Object.assign(input, {
    moveX: 0, moveZ: 0, moving: false, flying: false, surf: false,
    fire: false, sprint: false, riseLevel: 1, thrust: false,
    boost: false, vert: 0,
  });
  Object.assign(S, {
    flightThrottle: false,
    speederClimbMax: 18,
    speederClimbRate: 2.2,
    speederClimbSpeed: 9,
    speederCeiling: 24,
  });
}

beforeEach(() => {
  savedInput.clear();
  savedS.clear();
  for (const k of INPUT_KEYS) savedInput.set(k, (input as Record<string, unknown>)[k]);
  for (const k of S_KEYS) savedS.set(k, (S as Record<string, unknown>)[k]);
  resetGlobals();
});

afterEach(() => {
  for (const k of INPUT_KEYS) (input as Record<string, unknown>)[k] = savedInput.get(k);
  for (const k of S_KEYS) (S as Record<string, unknown>)[k] = savedS.get(k);
  vi.restoreAllMocks();
});

function make(terrain: TerrainStub = flatTerrain()) {
  return new CharacterController(terrain);
}

function run(c: CharacterController, rig: CameraRig, seconds: number, dt = DT) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) c.update(dt, rig);
}

describe("walk<->surf blend", () => {
  it("starts at 0 and eases upward (not snapped) when surf is held", () => {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    expect(c.surf).toBe(0);
    c.update(DT, rig);
    expect(c.surf).toBeGreaterThan(0);
    expect(c.surf).toBeLessThan(1);
    // one expDamp step toward 1 at rate 2.6
    expect(c.surf).toBeCloseTo(1 - Math.exp(-2.6 * DT), 5);
  });

  it("eases back down when surf is released", () => {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    run(c, rig, 2);
    const high = c.surf;
    expect(high).toBeGreaterThan(0.99);
    input.surf = false;
    c.update(DT, rig);
    expect(c.surf).toBeLessThan(high);
    expect(c.surf).toBeGreaterThan(0);
  });

  it("converges to ~1 while held and stays finite", () => {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    run(c, rig, 5);
    expect(c.surf).toBeGreaterThan(0.999);
    expect(Number.isFinite(c.surf)).toBe(true);
  });
});

describe("walk vs surf step selection (SURF_SPLIT = 0.5)", () => {
  it("at surf exactly 0.5 the walk step runs: facing eases toward rig.yaw", () => {
    const c = make();
    const rig = makeRig(1.0);
    c.surf = 0.5;
    input.surf = false; // blend eases down through the split this frame
    c.facing = 0;
    c.update(DT, rig);
    expect(c.surf).toBeLessThanOrEqual(0.5);
    // angleDamp(0, 1, TURN_EASE=11, 1/30)
    expect(c.facing).toBeCloseTo(1 - Math.exp(-11 * DT), 5);
  });

  it("just above the split the surf step runs: facing turns via steer, not the walk ease", () => {
    const c = make();
    const rig = makeRig(1.0);
    c.surf = 0.5001;
    input.surf = true; // blend eases up, stays above the split
    c.facing = 0;
    c.update(DT, rig);
    // surf path: steerRaw = clamp(0*0.85 + angleDelta(0,1)*1.25) = 1,
    // steer = expDamp(0,1,12,h), facing += steer * SURF_TURN(2.35) * h
    const steer = 1 - Math.exp(-12 * DT);
    expect(c.facing).toBeCloseTo(steer * 2.35 * DT, 5);
    expect(c.facing).not.toBeCloseTo(1 - Math.exp(-11 * DT), 3);
  });

  it("wrapped yaw delta eases across ±π the short way", () => {
    const c = make();
    const rig = makeRig(-3.0);
    c.surf = 0;
    c.facing = 3.0;
    c.update(DT, rig);
    // shortest arc from 3.0 to -3.0 is +0.2832, so facing grows past 3.0
    expect(c.facing).toBeGreaterThan(3.0);
  });
});

describe("walk step: speed caps and input shaping", () => {
  it("walk speed caps at 2.5 m/s without sprint", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    run(c, rig, 5);
    expect(c.speed).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(c.speed).toBeGreaterThan(2.4);
  });

  it("sprint raises the on-foot ceiling to RUN_SPEED", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    input.sprint = true;
    run(c, rig, 5);
    expect(c.speed).toBeLessThanOrEqual(RUN_SPEED + 1e-6);
    expect(c.speed).toBeGreaterThan(RUN_SPEED - 0.1);
  });

  it("diagonal input is normalised — never exceeds the cap (disc handling)", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveX = 1;
    input.moveZ = 1; // length sqrt(2) if passed through raw
    input.moving = true;
    input.sprint = true;
    run(c, rig, 5);
    expect(c.speed).toBeLessThanOrEqual(RUN_SPEED + 1e-6);
  });

  it("from rest, one frame of acceleration matches WALK_ACCEL", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    input.sprint = true;
    c.update(DT, rig);
    expect(c.acceleration.z).toBeCloseTo(26, 3);
  });

  it("wish with no input decays velocity toward zero", () => {
    const c = make();
    const rig = makeRig(0);
    c.velocity.set(3, 0, 0);
    run(c, rig, 2);
    expect(Math.hypot(c.velocity.x, c.velocity.z)).toBeLessThan(0.5);
  });
});

describe("surf step: thrust, grip, drag", () => {
  function surfing() {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    input.flying = false;
    c.surf = 1; // fully on the board
    return { c, rig };
  }

  it("thrust accelerates along facing (sin/cos)", () => {
    const { c, rig } = surfing();
    c.facing = 0; // forward = +z
    input.moveZ = 1;
    input.moving = true;
    c.update(DT, rig);
    expect(c.velocity.z).toBeGreaterThan(0);
    expect(Math.abs(c.velocity.x)).toBeLessThan(1e-6);
  });

  it("lateral (sideways) velocity is bled off by grip", () => {
    const { c, rig } = surfing();
    c.facing = 0;
    c.velocity.set(6, 0, 0); // pure sideways for facing=0 (right = +x)
    c.update(DT, rig);
    expect(Math.abs(c.velocity.x)).toBeLessThan(6);
  });

  it("a hard tail wind reaches a terminal speed below SURF_MAX*BOOST", () => {
    const { c, rig } = surfing();
    input.moveZ = 1;
    input.moving = true;
    run(c, rig, 30);
    expect(c.speed).toBeLessThan(19.5 * 1.95 + 0.5);
    expect(c.speed).toBeGreaterThan(10); // sanity: it actually got going
  });

  it("downhill slope adds acceleration (slope assist)", () => {
    // normal tilted so the surface falls away toward +z (facing 0)
    const slope: TerrainStub = {
      heightAt: () => 0,
      normalAt: (_x, _z, out) => out.set(0, Math.cos(0.3), -Math.sin(0.3)).normalize(),
    };
    const c = make(slope);
    const rig = makeRig(0);
    input.surf = true;
    c.surf = 1;
    c.facing = 0;
    c.update(DT, rig);
    // slopeAssist = -(n.z * fz) * 26 > 0 — velocity.z gain exceeds flat-board thrust-only? no:
    // just assert it gained forward speed and the assist sign is positive
    expect(c.velocity.z).toBeGreaterThan(0);
    const flat = make();
    const rig2 = makeRig(0);
    input.surf = true;
    flat.surf = 1;
    flat.facing = 0;
    flat.update(DT, rig2);
    expect(c.velocity.z).toBeGreaterThan(flat.velocity.z);
  });
});

describe("speed01 / speedRaw / acceleration bookkeeping", () => {
  it("speed01 clamps at 1 while speedRaw keeps growing", () => {
    const c = make();
    const rig = makeRig(0);
    c.applyImpact(30, 0, 0, 0);
    c.update(DT, rig);
    expect(c.speed01).toBe(1);
    expect(c.speedRaw).toBeGreaterThan(1);
  });

  it("acceleration reflects per-frame velocity delta", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    input.sprint = true;
    c.velocity.set(5, 0, 0);
    c.update(DT, rig);
    expect(Number.isFinite(c.acceleration.x)).toBe(true);
    expect(Number.isFinite(c.acceleration.z)).toBe(true);
  });

  it("freeze-time (dt = 0) leaves everything finite and zeroes acceleration", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    input.surf = true;
    c.surf = 1;
    c.velocity.set(4, 0, 2);
    c.update(0, rig);
    for (const v of [c.position.x, c.position.y, c.position.z, c.velocity.x, c.velocity.z]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(c.acceleration.x).toBe(0);
    expect(c.acceleration.z).toBe(0);
    expect(c.steerRate).toBe(0);
    expect(c.climbRate).toBe(0);
  });

  it("freeze-time also holds in walk mode without NaN", () => {
    const c = make();
    const rig = makeRig(0.5);
    input.moveX = 1;
    input.moveZ = 1;
    c.update(1e-7, rig);
    expect(Number.isFinite(c.position.y)).toBe(true);
    expect(Number.isFinite(c.facing)).toBe(true);
    expect(c.acceleration.x).toBe(0);
  });
});

describe("ground clamp against stub terrain", () => {
  it("position.y converges onto raised flat terrain", () => {
    const high: TerrainStub = {
      heightAt: () => 3,
      normalAt: (_x, _z, out) => out.set(0, 1, 0),
    };
    const c = make(high);
    const rig = makeRig(0);
    run(c, rig, 5);
    expect(c.position.y).toBeCloseTo(3, 1);
    expect(c.groundY).toBe(3);
  });

  it("position.y follows terrain downward", () => {
    let h = 8;
    const falling: TerrainStub = {
      heightAt: () => h,
      normalAt: (_x, _z, out) => out.set(0, 1, 0),
    };
    const c = make(falling);
    const rig = makeRig(0);
    run(c, rig, 2);
    const before = c.position.y;
    h = 0;
    run(c, rig, 5);
    expect(c.position.y).toBeLessThan(before);
    expect(c.position.y).toBeCloseTo(0, 0);
  });
});

describe("controlScramble decay and _scrambleMax reset", () => {
  it("applyImpact sets and extends (never shortens) the scramble", () => {
    const c = make();
    c.applyImpact(0, 0, 0, 2.0);
    expect(c.controlScramble).toBe(2.0);
    expect(c._scrambleMax).toBe(2.0);
    c.applyImpact(0, 0, 0, 0.5);
    expect(c.controlScramble).toBe(2.0); // not shortened
    c.applyImpact(0, 0, 0, 3.0);
    expect(c.controlScramble).toBe(3.0); // extended
    expect(c._scrambleMax).toBe(3.0);
  });

  it("scramble decays to exactly 0 and _scrambleMax resets with it", () => {
    const c = make();
    const rig = makeRig(0);
    c.applyImpact(0, 0, 0, 1.0);
    run(c, rig, 1.5);
    expect(c.controlScramble).toBe(0);
    expect(c._scrambleMax).toBe(0);
  });
});

describe("applyImpact", () => {
  it("overwrites planar velocity and clamps the spin kick to ±3.5", () => {
    const c = make();
    c.applyImpact(1, 2, 99, 0);
    expect(c.velocity.x).toBe(1);
    expect(c.velocity.z).toBe(2);
    expect(c.impactSpin).toBe(3.5);
    c.applyImpact(0, 0, -99, 0);
    expect(c.impactSpin).toBe(-3.5);
  });

  it("spin kick accumulates then bleeds off during surf steps", () => {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    c.surf = 1;
    c.applyImpact(0, 0, 2.0, 0);
    const before = c.impactSpin;
    c.update(DT, rig);
    expect(Math.abs(c.impactSpin)).toBeLessThan(before);
    expect(c.impactSpin).not.toBe(0);
  });

  it("is a no-op while crashing (velocity untouched)", () => {
    const c = make();
    c.beginCrash(1);
    c.velocity.set(7, 0, 8);
    c.applyImpact(0, 0, 3.5, 5.0);
    expect(c.velocity.x).toBe(7);
    expect(c.velocity.z).toBe(8);
    expect(c.impactSpin).toBe(0);
    expect(c.controlScramble).toBe(0);
  });
});

describe("crash state machine", () => {
  it("spin sign comes from Math.random when not given (< 0.5 → -1, else +1)", () => {
    const c1 = make();
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    c1.beginCrash();
    expect(c1._crashSpin).toBe(-1);
    vi.restoreAllMocks();
    const c2 = make();
    vi.spyOn(Math, "random").mockReturnValue(0.9);
    c2.beginCrash();
    expect(c2._crashSpin).toBe(1);
  });

  it("explicit spinDir overrides the coin flip", () => {
    const c = make();
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    c.beginCrash(1);
    expect(c._crashSpin).toBe(1);
  });

  it("beginCrash pins the surf pose, clears impacts, sets crashing", () => {
    const c = make();
    const rig = makeRig(0);
    c.applyImpact(0, 0, 2, 1);
    c.beginCrash(-1);
    expect(c.crashing).toBe(true);
    expect(c.crashDown).toBe(false);
    expect(c.crashLanded).toBe(false);
    expect(c.impactSpin).toBe(0);
    expect(c.controlScramble).toBe(0);
    expect(c.terrainSlam).toBeNull();
    c.update(DT, rig);
    expect(c.surf).toBe(1); // pinned, not eased
    expect(c.fireHeld).toBe(false);
    expect(c.driveHeld).toBe(false);
    expect(c.boostHeld).toBe(false);
    expect(c.steer).toBe(0);
  });

  it("full sequence: falling → crashLanded/crashDown latch → endCrash restores", () => {
    const c = make();
    const rig = makeRig(0);
    c.beginCrash(1);
    // drive the fall; expect a landing within the 2.1 s profile + margin
    let landed = false;
    for (let i = 0; i < 60 * 4 && !landed; i++) {
      c.update(DT, rig);
      landed = c.crashDown;
    }
    expect(c.crashLanded).toBe(true);
    expect(c.crashDown).toBe(true);
    // wreck settles onto the snow, never below the rest floor
    expect(c.position.y).toBeGreaterThanOrEqual(0 + 0.3 - 1e-6);
    run(c, rig, 2); // plough/settle phase
    expect(Number.isFinite(c.position.y)).toBe(true);
    expect(c.position.y).toBeGreaterThanOrEqual(0.3 - 1e-6);
    // RECOVER
    c.endCrash();
    expect(c.crashing).toBe(false);
    expect(c.crashDown).toBe(false);
    expect(c.crashLanded).toBe(false);
    expect(c.fireHeld).toBeUndefined();
    expect(c.driveHeld).toBeUndefined();
    expect(c.boostHeld).toBeUndefined();
    expect(c.lean).toBe(0);
    expect(c.carve).toBe(0);
    expect(c.impactSpin).toBe(0);
    expect(c.controlScramble).toBe(0);
    expect(c._scrambleMax).toBe(0);
  });

  it("nose drift stops once the wreck is down", () => {
    const c = make();
    const rig = makeRig(0);
    c.beginCrash(1);
    for (let i = 0; i < 60 * 6 && !c.crashDown; i++) c.update(DT, rig);
    expect(c.crashDown).toBe(true);
    const f = c.facing;
    run(c, rig, 1);
    expect(c.facing).toBe(f);
  });

  it("beginCrash is idempotent while already crashing", () => {
    const c = make();
    c.beginCrash(1);
    c._crashT = 1.23;
    c.beginCrash(-1); // must not reset
    expect(c._crashSpin).toBe(1);
    expect(c._crashT).toBe(1.23);
  });
});

describe("climb ladder — classic scheme", () => {
  function airborne(c: CharacterController) {
    input.flying = true;
    input.surf = true;
    c.surf = 1;
  }

  it("E rung 2 climbs toward mid (0.45 × speederClimbMax)", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.riseLevel = 2;
    run(c, rig, 3);
    expect(c._climb).toBeGreaterThan(5);
    expect(c._climb).toBeLessThanOrEqual(0.45 * 18 + 1e-6);
    expect(c.climbRate).toBeGreaterThan(0);
  });

  it("E rung 3 climbs toward the full ceiling", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.riseLevel = 3;
    run(c, rig, 6);
    expect(c._climb).toBeGreaterThan(15);
    expect(c._climb).toBeLessThanOrEqual(18 + 1e-6);
  });

  it("E rung 1 (deck) keeps the climb at zero", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.riseLevel = 1;
    run(c, rig, 2);
    expect(c._climb).toBeCloseTo(0, 6);
  });

  it("out-of-range riseLevel is clamped to the 1..3 ladder", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.riseLevel = 99;
    run(c, rig, 6);
    expect(c._climb).toBeLessThanOrEqual(18 + 1e-6);
    expect(c._climb).toBeGreaterThan(15); // treated as rung 3
    const c2 = make();
    const rig2 = makeRig(0);
    airborne(c2);
    input.riseLevel = -4;
    run(c2, rig2, 2);
    expect(c2._climb).toBeCloseTo(0, 6); // treated as rung 1
  });

  it("lift01 saturates at 1 by the mid rung and stays finite", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.riseLevel = 3;
    run(c, rig, 6);
    expect(c.lift01).toBe(1);
    expect(c.lift01).toBeLessThanOrEqual(1);
  });

  it("not flying → no climb regardless of riseLevel", () => {
    const c = make();
    const rig = makeRig(0);
    input.flying = false; // on the board, not airborne
    input.surf = true;
    c.surf = 1;
    input.riseLevel = 3;
    run(c, rig, 2);
    expect(c._climb).toBeCloseTo(0, 6);
  });
});

describe("climb ladder — throttle scheme (S.flightThrottle)", () => {
  function airborne(c: CharacterController) {
    input.flying = true;
    input.surf = true;
    input.boost = false;
    input.thrust = false;
    input.vert = 0;
    c.surf = 1;
    S.flightThrottle = true;
  }

  it("holding climb (vert=+1) raises _climbWant and _climb", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.vert = 1;
    run(c, rig, 3);
    expect(c._climbWant).toBeGreaterThan(0);
    expect(c._climb).toBeGreaterThan(0);
    expect(c._vertEase).toBeGreaterThan(0.9); // slewed close to 1
  });

  it("letting go holds altitude — the climb does not settle back", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.vert = 1;
    run(c, rig, 2);
    const held = c._climb;
    input.vert = 0;
    run(c, rig, 2);
    // holds station: eases up to the stored want, never sinks back toward the deck
    expect(c._climb).toBeGreaterThanOrEqual(held - 1e-6);
    expect(c._climb).toBeGreaterThan(held * 0.9);
    expect(c._climbWant).toBeGreaterThanOrEqual(held);
  });

  it("_climbWant clamps at speederCeiling", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.vert = 1;
    run(c, rig, 10);
    expect(c._climbWant).toBeLessThanOrEqual(24 + 1e-6);
    expect(c._climbWant).toBeCloseTo(24, 1);
  });

  it("_vertEase slews rather than stepping (first frame ≈ 1-exp(-12/30))", () => {
    const c = make();
    const rig = makeRig(0);
    airborne(c);
    input.vert = 1;
    c.update(DT, rig);
    expect(c._vertEase).toBeGreaterThan(0);
    expect(c._vertEase).toBeLessThan(1);
    expect(c._vertEase).toBeCloseTo(1 - Math.exp(-12 * DT), 5);
  });

  it("mid-flight scheme swap adopts current height as the flown target", () => {
    const c = make();
    const rig = makeRig(0);
    // classic first: climb to mid rung
    input.flying = true;
    input.surf = true;
    c.surf = 1;
    input.riseLevel = 2;
    run(c, rig, 3);
    const climbed = c._climb;
    expect(climbed).toBeGreaterThan(1);
    // swap schemes
    S.flightThrottle = true;
    input.riseLevel = 3; // swap must reset this to 1
    c.update(DT, rig);
    expect(c._wasThrottle).toBe(true);
    expect(input.riseLevel).toBe(1);
    expect(c._climbWant).toBeCloseTo(climbed, 1);
  });
});

describe("gait / stepping", () => {
  it("stepping is false at surf > SURF_SPLIT and gaitPhase holds", () => {
    const c = make();
    const rig = makeRig(0);
    input.surf = true;
    c.surf = 1;
    c.update(DT, rig);
    expect(c.stepping).toBe(false);
    expect(c.gaitPhase).toBe(0);
  });

  it("on foot at speed, gait phase advances and footfalls fire", () => {
    const c = make();
    const rig = makeRig(0);
    input.moveZ = 1;
    input.moving = true;
    input.sprint = true;
    let sawFootfall = false;
    for (let i = 0; i < 240; i++) {
      c.update(DT, rig);
      if (c.footfall) sawFootfall = true;
    }
    expect(sawFootfall).toBe(true);
    expect(c.gaitPhase).toBeGreaterThanOrEqual(0);
    expect(c.gaitPhase).toBeLessThan(1);
  });
});
