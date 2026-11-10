import { describe, it, expect, afterEach, vi } from "vitest";
import {
  Figure,
  B_ROOT,
  B_SPINE,
  B_CHEST,
  B_NECK,
  B_HEAD,
  B_HAND_R,
  B_SHIN_L,
  BONE_COUNT,
  type TerrainLike,
} from "../src/character/figure.js";
import { mul } from "../src/core/mat4.js";
import { RUN_SPEED } from "../src/character/controller.js";
import type { CharacterController } from "../src/character/controller.js";

const flatTerrain: TerrainLike = {
  heightAt: () => 0,
  normalAt: (_x, _z, out) => out.set(0, 1, 0),
};

/** Fake controller literal — only the fields Figure actually reads. */
const fakeController = (over: Record<string, unknown> = {}) =>
  ({
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    acceleration: { x: 0, z: 0 },
    facing: 0,
    surf: 0,
    speed: 0,
    speed01: 0,
    lean: 0,
    gaitPhase: 0,
    stepping: true,
    footfall: false,
    footIndex: 1,
    footPos: { x: 0, z: 0 },
    cast: 0,
    castAimX: 0,
    castAimY: 1,
    castAimZ: 0,
    carve: 0,
    ...over,
  }) as unknown as CharacterController;

const step = (fig: Figure, ch: CharacterController, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds; t += dt) fig.update(dt, ch);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Figure bind pose", () => {
  it("invBind * bind ≈ identity for all 18 bones", () => {
    const fig = new Figure(flatTerrain);
    const tmp = new Float32Array(16);
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let b = 0; b < BONE_COUNT; b++) {
      mul(tmp, 0, fig.invBind, b * 16, fig.bind, b * 16);
      for (let i = 0; i < 16; i++) {
        expect(tmp[i], `bone ${b} elem ${i}`).toBeCloseTo(I[i], 5);
      }
    }
  });

  it("bind matrices carry finite, rigid frames (orthonormal axes)", () => {
    const fig = new Figure(flatTerrain);
    for (let b = 0; b < BONE_COUNT; b++) {
      const o = b * 16;
      const xx = fig.bind[o], xy = fig.bind[o + 1], xz = fig.bind[o + 2];
      const yx = fig.bind[o + 4], yy = fig.bind[o + 5], yz = fig.bind[o + 6];
      const zx = fig.bind[o + 8], zy = fig.bind[o + 9], zz = fig.bind[o + 10];
      for (const v of [xx, xy, xz, yx, yy, yz, zx, zy, zz]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.hypot(xx, xy, xz)).toBeCloseTo(1, 5);
      expect(Math.hypot(yx, yy, yz)).toBeCloseTo(1, 5);
      expect(Math.hypot(zx, zy, zz)).toBeCloseTo(1, 5);
      expect(xx * yx + xy * yy + xz * yz).toBeCloseTo(0, 5);
      expect(xx * zx + xy * zy + xz * zz).toBeCloseTo(0, 5);
      expect(yx * zx + yy * zy + yz * zz).toBeCloseTo(0, 5);
    }
  });

  it("joint buffer mirrors the world-matrix translations after update", () => {
    const fig = new Figure(flatTerrain);
    const ch = fakeController();
    fig.update(1 / 60, ch);
    for (let b = 0; b < BONE_COUNT; b++) {
      expect(fig.joint[b * 3]).toBeCloseTo(fig.world[b * 16 + 12], 6);
      expect(fig.joint[b * 3 + 1]).toBeCloseTo(fig.world[b * 16 + 13], 6);
      expect(fig.joint[b * 3 + 2]).toBeCloseTo(fig.world[b * 16 + 14], 6);
    }
  });

  it("standing on flat terrain keeps every joint finite and upright ordering", () => {
    const fig = new Figure(flatTerrain);
    const ch = fakeController();
    step(fig, ch, 1);
    for (let b = 0; b < BONE_COUNT; b++) {
      expect(Number.isFinite(fig.joint[b * 3])).toBe(true);
      expect(Number.isFinite(fig.joint[b * 3 + 1])).toBe(true);
      expect(Number.isFinite(fig.joint[b * 3 + 2])).toBe(true);
    }
    const y = (b: number) => fig.joint[b * 3 + 1];
    expect(y(B_ROOT)).toBeLessThan(y(B_SPINE));
    expect(y(B_SPINE)).toBeLessThan(y(B_CHEST));
    expect(y(B_CHEST)).toBeLessThan(y(B_NECK));
    expect(y(B_NECK)).toBeLessThan(y(B_HEAD));
  });

  it("update clamps dt to MAX_STEP (1/30 s)", () => {
    const a = new Figure(flatTerrain);
    const b = new Figure(flatTerrain);
    a.update(1.0, fakeController());
    b.update(1 / 30, fakeController());
    expect(a._t).toBeCloseTo(1 / 30, 8);
    expect(a._t).toBeCloseTo(b._t, 8);
  });
});

describe("Figure gait / stance / swing", () => {
  it("advances pose with the controller's gaitPhase (different phases → different feet)", () => {
    const a = new Figure(flatTerrain);
    const b = new Figure(flatTerrain);
    const base = { speed: RUN_SPEED, stepping: true, velocity: { x: 0, z: RUN_SPEED } };
    step(a, fakeController({ ...base, gaitPhase: 0.0 }), 0.2);
    step(b, fakeController({ ...base, gaitPhase: 0.7 }), 0.2);
    expect(a.footPos[0 * 3 + 1]).not.toBeCloseTo(b.footPos[0 * 3 + 1], 3);
  });

  it("selects stance vs swing feet from gaitPhase and speed", () => {
    const fig = new Figure(flatTerrain);
    const ch = fakeController({ speed: 0, stepping: true });
    step(fig, ch, 0.5); // settle plants while standing
    // Walking at phase 0.7: left foot (ph 0.7) is past the 0.66 duty cycle → swing.
    const walk = fakeController({ speed: 1.0, stepping: true, gaitPhase: 0.7, velocity: { x: 0, z: 1.0 } });
    fig.update(1 / 60, walk);
    expect(fig.footWeight[0]).toBeLessThan(fig.footWeight[1]);
    // At phase 0.1: both feet inside the walk duty window → both stance.
    const early = fakeController({ speed: 1.0, stepping: true, gaitPhase: 0.1, velocity: { x: 0, z: 1.0 } });
    fig.update(1 / 60, early);
    expect(fig._wasStance[0]).toBe(true);
    expect(fig._wasStance[1]).toBe(true);
  });

  it("swing foot lifts off the ground along an arc above its plant", () => {
    const fig = new Figure(flatTerrain);
    const stand = fakeController({ speed: 0, stepping: true });
    step(fig, stand, 0.5);
    const plantY = fig.plant[0 * 3 + 1];
    const swing = fakeController({ speed: 1.0, stepping: true, gaitPhase: 0.8, velocity: { x: 0, z: 1.0 } });
    fig.update(1 / 60, swing);
    expect(fig.footPos[0 * 3 + 1]).toBeGreaterThan(plantY);
  });

  it("planted foot stays frozen while the body travels over it during stance", () => {
    const fig = new Figure(flatTerrain);
    const stand = fakeController({ speed: 0, stepping: true });
    step(fig, stand, 0.5);
    const walkFar = fakeController({
      speed: 1.0, stepping: true, gaitPhase: 0.1,
      position: { x: 3, y: 0, z: -2 }, velocity: { x: 0, z: 1.0 },
    });
    const before = Array.from(fig.plant);
    fig.update(1 / 60, walkFar);
    expect(Array.from(fig.plant)).toEqual(before);
    expect(fig.footPos[0]).toBe(fig.plant[0]);
    expect(fig.footPos[1]).toBe(fig.plant[1]);
    expect(fig.footPos[2]).toBe(fig.plant[2]);
    expect(fig.footPos[3]).toBe(fig.plant[3]);
  });

  it("touchdown fires exactly one frame on a swing→stance transition", () => {
    const fig = new Figure(flatTerrain);
    const stand = fakeController({ speed: 0, stepping: true });
    step(fig, stand, 0.3);
    const swing = fakeController({ speed: 1.0, stepping: true, gaitPhase: 0.8, velocity: { x: 0, z: 1.0 } });
    fig.update(1 / 60, swing);
    expect(fig._wasStance[0]).toBe(false);
    expect(fig.touchdown[0]).toBe(false);
    const land = fakeController({ speed: 1.0, stepping: true, gaitPhase: 0.05, velocity: { x: 0, z: 1.0 } });
    fig.update(1 / 60, land);
    expect(fig.touchdown[0]).toBe(true);
    const plantAtTouchdown = Array.from(fig.plant);
    fig.update(1 / 60, land);
    expect(fig.touchdown[0]).toBe(false);
    expect(Array.from(fig.plant)).toEqual(plantAtTouchdown);
  });

  it("stand-still feet ease back under the hips", () => {
    const fig = new Figure(flatTerrain);
    const ch = fakeController({ position: { x: 1, y: 0, z: 2 }, speed: 0, stepping: false });
    step(fig, ch, 2);
    // facing 0 → right = (1,0,0); left foot sits at -FOOT_OFFSET, slightly ahead.
    expect(fig.plant[0]).toBeCloseTo(1 - 0.105, 2);
    expect(fig.plant[2]).toBeCloseTo(2 + 0.02, 2);
    expect(fig.plant[3]).toBeCloseTo(1 + 0.105, 2);
    expect(fig.plant[5]).toBeCloseTo(2 + 0.02, 2);
  });

  it("easing settles into the surf posture (pitch, crouch, sink) over time", () => {
    const fig = new Figure(flatTerrain);
    const surf = fakeController({ surf: 1, speed01: 1, speed: RUN_SPEED, stepping: false });
    step(fig, surf, 3);
    // RUN_LEAN (0.10) at speed01=1, plus surf lean: 0.30 + 0.16
    expect(fig.pitch).toBeCloseTo(0.10 + 0.30 + 0.16, 2);
    expect(fig.hipY).toBeCloseTo(0.95 - (0.035 + 0.13 + 0.05), 2); // CROUCH_RUN + surf crouch + speed01 bonus
    expect(fig.sink).toBeCloseTo(0.045 + 0.055, 2);
    expect(fig.bob).toBeCloseTo(0, 3);
  });

  it("bob dips negative while running and vanishes while surfing", () => {
    const run = new Figure(flatTerrain);
    const surfFig = new Figure(flatTerrain);
    // cos(BOB_CYCLES * pi * gaitPhase) = -1 at gaitPhase 0.25 → target = -BOB_DEPTH * run.
    const runCh = fakeController({ speed: RUN_SPEED, stepping: true, gaitPhase: 0.25, velocity: { x: 0, z: RUN_SPEED } });
    const surfCh = fakeController({ surf: 1, speed01: 1, speed: RUN_SPEED, stepping: false, gaitPhase: 0.25 });
    step(run, runCh, 1.5);
    step(surfFig, surfCh, 1.5);
    expect(run.bob).toBeLessThan(-0.01);
    expect(Math.abs(surfFig.bob)).toBeLessThan(0.005);
  });

  it("roll eases toward controller lean (surf amplifies it)", () => {
    const fig = new Figure(flatTerrain);
    const leaning = fakeController({ lean: 0.5, surf: 1, speed01: 0.5, stepping: false });
    step(fig, leaning, 2);
    // rollWant = lean * (ROLL_PER_LEAN + ROLL_SURF * surf) = 0.5 * (0.16 + 0.34) = 0.25
    expect(fig.roll).toBeCloseTo(0.25, 2);
  });

  it("is deterministic: two figures fed the same controller end in the same pose", () => {
    const a = new Figure(flatTerrain);
    const b = new Figure(flatTerrain);
    const ch = fakeController({ speed: 2, gaitPhase: 0.3, velocity: { x: 0, z: 2 }, facing: 0.4 });
    step(a, ch, 1);
    step(b, ch, 1);
    expect(Array.from(a.world)).toEqual(Array.from(b.world));
  });
});

describe("Figure two-bone IK (via _poseLeg)", () => {
  // Identity body frame: right=(1,0,0), up=(0,1,0), forward=(0,0,1).
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

  const poseLeftLeg = (fig: Figure, footX: number, footY: number, footZ: number) => {
    fig.footPos.set([footX, footY, footZ, 0, 0, 0]);
    fig.footWeight.set([1, 1]);
    fig._poseLeg(0, 0, 0.95, 0, IDENTITY[0], IDENTITY[1], IDENTITY[2], IDENTITY[3], IDENTITY[4], IDENTITY[5], IDENTITY[6], IDENTITY[7], IDENTITY[8]);
    return {
      hip: [-0.10, 0.90, 0] as const, // root + r*(-HIP_SPREAD) - u*HIP_DROP
      knee: [fig.world[B_SHIN_L * 16 + 12], fig.world[B_SHIN_L * 16 + 13], fig.world[B_SHIN_L * 16 + 14]] as const,
      ankleY: footY + 0.09,
    };
  };

  it("reachable target: knee sits exactly THIGH_LEN from hip and SHIN_LEN from ankle", () => {
    const fig = new Figure(flatTerrain);
    const { hip, knee, ankleY } = poseLeftLeg(fig, 0, 0.30, 0);
    const dHip = Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]);
    const dAnkle = Math.hypot(knee[0] - 0, knee[1] - ankleY, knee[2] - 0);
    expect(dHip).toBeCloseTo(0.44, 5);
    expect(dAnkle).toBeCloseTo(0.37, 5);
  });

  it("reachable target: knee bends off the hip→ankle axis by the cosine-rule height", () => {
    const fig = new Figure(flatTerrain);
    const { hip, knee, ankleY } = poseLeftLeg(fig, 0, 0.30, 0);
    const ax = [0 - hip[0], ankleY - hip[1], 0 - hip[2]];
    const dist = Math.hypot(ax[0], ax[1], ax[2]);
    const l1 = 0.44, l2 = 0.37;
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const kx = knee[0] - hip[0], ky = knee[1] - hip[1], kz = knee[2] - hip[2];
    const crossX = ky * ax[2] - kz * ax[1];
    const crossY = kz * ax[0] - kx * ax[2];
    const crossZ = kx * ax[1] - ky * ax[0];
    const perp = Math.hypot(crossX, crossY, crossZ) / dist;
    expect(h).toBeGreaterThan(0.2); // sanity: genuinely bent, not near-locked
    expect(perp).toBeCloseTo(h, 4);
  });

  it("unreachable target: clamped to near-straight leg (knee on the hip→ankle axis)", () => {
    const fig = new Figure(flatTerrain);
    const { hip, knee, ankleY } = poseLeftLeg(fig, 0, -3.0, 0); // ankle ~3.8 m away, way past 0.81 m reach
    const dHip = Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]);
    expect(dHip).toBeCloseTo(0.44, 5);
    const ax = [0 - hip[0], ankleY - hip[1], 0 - hip[2]];
    const dist = Math.hypot(ax[0], ax[1], ax[2]);
    const kx = knee[0] - hip[0], ky = knee[1] - hip[1], kz = knee[2] - hip[2];
    const crossX = ky * ax[2] - kz * ax[1];
    const crossY = kz * ax[0] - kx * ax[2];
    const crossZ = kx * ax[1] - ky * ax[0];
    const perp = Math.hypot(crossX, crossY, crossZ) / dist;
    expect(perp).toBeLessThan(0.05);
  });

  it("deterministic: identical inputs reproduce the identical knee", () => {
    const a = new Figure(flatTerrain);
    const b = new Figure(flatTerrain);
    const ra = poseLeftLeg(a, 0.05, 0.25, 0.1);
    const rb = poseLeftLeg(b, 0.05, 0.25, 0.1);
    expect(ra.knee).toEqual(rb.knee);
  });
});

describe("Figure handPosition", () => {
  it("writes the right-hand bone origin plus HAND_OFFSET along the bone's Y axis", () => {
    const fig = new Figure(flatTerrain);
    fig.update(1 / 60, fakeController({ speed: 1, velocity: { x: 0, z: 1 } }));
    const out = new Float32Array(6);
    fig.handPosition(1, out, 3);
    const o = B_HAND_R * 16;
    const wx = fig.world[o + 12], wy = fig.world[o + 13], wz = fig.world[o + 14];
    // HAND_OFFSET = 0.09 along local +Y (second column of the basis).
    expect(out[3]).toBeCloseTo(wx + fig.world[o + 4] * 0.09, 5);
    expect(out[4]).toBeCloseTo(wy + fig.world[o + 5] * 0.09, 5);
    expect(out[5]).toBeCloseTo(wz + fig.world[o + 6] * 0.09, 5);
    fig.handPosition(0, out, 0);
    expect(out[0]).not.toBeCloseTo(out[3], 3);
  });
});
