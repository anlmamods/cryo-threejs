import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { expDamp, CameraRig } from "../src/core/camera.js";
import { input } from "../src/core/input.js";
import { S } from "../src/core/settings.js";

const DT = 1 / 60;
const FEET = new THREE.Vector3(0, 0, 0);
const VEL0 = new THREE.Vector3(0, 0, 0);

function makeRig() {
 // gfx stub: no renderer/canvas anywhere, _aspect() falls back to 16/9.
 return new CameraRig({} as never, null);
}

function step(rig: CameraRig, seconds: number, dt = DT, lean = 0, speed01 = 0) {
 const steps = Math.round(seconds / dt);
 for (let i = 0; i < steps; i++) {
  rig.update(dt, FEET, VEL0, lean, speed01);
 }
}

const saved: Record<string, unknown> = {};
beforeEach(() => {
 input.lookX = 0;
 input.lookY = 0;
 input.zoomDelta = 0;
 input.sprint = false;
 for (const k of ["speeder", "cinematicCam", "camYawLag", "camBoostBreath"]) {
  saved[k] = (S as Record<string, unknown>)[k];
 }
});
afterEach(() => {
 for (const k of Object.keys(saved)) {
  (S as Record<string, unknown>)[k] = saved[k];
 }
});

describe("expDamp", () => {
 it("dt=0 returns cur", () => {
  expect(expDamp(5, 10, 1, 0)).toBe(5);
 });
 it("large dt approaches target", () => {
  expect(expDamp(5, 10, 1, 100)).toBeCloseTo(10);
 });
});

describe("CameraRig update — ground clearance", () => {
 it("keeps the camera above flat stub ground (ship framing)", () => {
  const rig = makeRig();
  rig.groundAt = () => 0;
  rig.update(DT, FEET, VEL0, 0, 0);
  expect(rig.camera.position.y).toBeGreaterThan(3.4); // GROUND_CLEARANCE_SHIP
 });

 it("keeps the camera above flat stub ground (foot framing)", () => {
  (S as Record<string, unknown>).speeder = false;
  const rig = makeRig();
  rig.groundAt = () => 0;
  rig.update(DT, FEET, VEL0, 0, 0);
  expect(rig.camera.position.y).toBeGreaterThan(1.35); // GROUND_CLEARANCE_FOOT
 });

 it("flat low ground leaves groundLift at zero", () => {
  const rig = makeRig();
  rig.groundAt = () => -100;
  step(rig, 0.5);
  expect(rig.groundLift).toBe(0);
 });

 it("lifts over a high wall (reactive probe)", () => {
  const rig = makeRig();
  rig.groundAt = () => 100;
  rig.update(DT, FEET, VEL0, 0, 0);
  expect(rig.groundLift).toBeGreaterThan(0);
 });

 it("predictive probe lifts for a crest ahead of the arm, before the arm reaches it", () => {
  // A ridge that exists ONLY at the predicted look-ahead offset
  // (px = pivotVel.x * PREDICT_SECONDS, PREDICT_SECONDS = 0.12).
  // pivotVel.x = 50 -> probes look 6 m ahead; the arm itself spans x ~= 0.
  const makeCrestRig = (velX: number) => {
   const rig = makeRig();
   rig.yaw = 0;
   rig.pitch = 0;
   rig.roll = 0;
   rig._first = false;
   rig.pivot.set(0, 4.2, 0);
   rig.pivotVel.set(velX, 0, 0);
   rig.groundAt = (x) => (x > 5 && x < 7 ? 100 : 0);
   return rig;
  };
  const moving = makeCrestRig(50);
  moving.update(DT, FEET, VEL0, 0, 0);
  expect(moving.groundLift).toBeGreaterThan(0);

  // Same world, no motion -> no look-ahead -> crest invisible to the probes.
  const still = makeCrestRig(0);
  still.update(DT, FEET, VEL0, 0, 0);
  expect(still.groundLift).toBe(0);
 });

 it("ground lift rises fast and relaxes slowly (LIFT_RISE 10 vs LIFT_FALL 4.5)", () => {
  const rig = makeRig();
  rig.groundAt = () => 100;
  rig.update(0.1, FEET, VEL0, 0, 0);
  const liftRise = rig.groundLift;
  expect(liftRise).toBeGreaterThan(0);

  // Ground drops away: need = 0, so the lift relaxes at LIFT_FALL.
  rig.groundAt = () => -1000;
  rig.update(0.1, FEET, VEL0, 0, 0);
  const liftFall = rig.groundLift;
  expect(liftFall).toBeCloseTo(liftRise * Math.exp(-4.5 * 0.1), 6);
  // ...and strictly slower than it rose (exp(-10*0.1) would be much lower).
  expect(liftFall).toBeGreaterThan(liftRise * Math.exp(-10 * 0.1));
 });
});

describe("CameraRig shake", () => {
 const runRig = (trauma: number) => {
  const rig = makeRig();
  rig.trauma = trauma;
  step(rig, 3 / 60);
  return rig;
 };

 it("shake > SHAKE_EPSILON perturbs the camera position", () => {
  const calm = runRig(0);
  const shaken = runRig(1);
  const d = calm.camera.position.distanceTo(shaken.camera.position);
  expect(d).toBeGreaterThan(1e-4);
 });

 it("shake > SHAKE_EPSILON perturbs the view basis (angles no longer exactly pitch/yaw/roll)", () => {
  const shaken = runRig(1);
  const before = Array.from(shaken.camera.view.elements);
  shaken._composeMatrices(shaken.pitch, shaken.yaw, shaken.roll);
  const after = Array.from(shaken.camera.view.elements);
  expect(after).not.toEqual(before);
 });

 it("shake = 0 leaves the view exactly at pitch/yaw/roll", () => {
  const rig = runRig(0);
  const before = Array.from(rig.camera.view.elements);
  rig._composeMatrices(rig.pitch, rig.yaw, rig.roll);
  expect(Array.from(rig.camera.view.elements)).toEqual(before);
 });
});

describe("CameraRig _composeMatrices", () => {
 const makeComposed = () => {
  const rig = makeRig();
  rig.update(DT, FEET, VEL0, 0, 0);
  return rig.camera;
 };

 it("view × invView ≈ identity", () => {
  const cam = makeComposed();
  const ident = new THREE.Matrix4().multiplyMatrices(cam.view, cam.invView);
  const e = ident.elements;
  for (let i = 0; i < 16; i++) {
   expect(e[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
  }
 });

 it("viewProjection = projection × view", () => {
  const cam = makeComposed();
  const expectVP = new THREE.Matrix4().multiplyMatrices(cam.projection, cam.view);
  for (let i = 0; i < 16; i++) {
   expect(cam.viewProjection.elements[i]).toBeCloseTo(expectVP.elements[i], 5);
  }
 });

 it("invViewProjection inverts viewProjection", () => {
  const cam = makeComposed();
  const ident = new THREE.Matrix4().multiplyMatrices(cam.viewProjection, cam.invViewProjection);
  const e = ident.elements;
  for (let i = 0; i < 16; i++) {
   expect(e[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 4);
  }
 });

 it("all published matrices are finite", () => {
  const cam = makeComposed();
  for (const m of [cam.view, cam.projection, cam.viewProjection, cam.invView, cam.invViewProjection]) {
   for (const v of m.elements) {
    expect(Number.isFinite(v)).toBe(true);
   }
  }
 });
});

describe("CameraRig framing (speeder vs foot)", () => {
 it("speeder build gets ship framing", () => {
  (S as Record<string, unknown>).speeder = true;
  const rig = makeRig();
  expect(rig.pitch).toBeCloseTo(0.42); // PITCH_SHIP
  expect(rig.distance).toBeCloseTo(11.5); // DIST_SHIP
  expect(rig.pivotHeight).toBeCloseTo(4.2); // PIVOT_HEIGHT_SHIP
  expect(rig.groundClearanceBase).toBeCloseTo(3.4); // GROUND_CLEARANCE_SHIP
  expect(rig.shoulder).toBe(0);
 });

 it("foot build gets shoulder framing", () => {
  (S as Record<string, unknown>).speeder = false;
  const rig = makeRig();
  expect(rig.pitch).toBeCloseTo(0.17); // PITCH_FOOT
  expect(rig.distance).toBeCloseTo(6.2); // DIST_FOOT
  expect(rig.pivotHeight).toBeCloseTo(1.62); // PIVOT_HEIGHT_FOOT
  expect(rig.groundClearanceBase).toBeCloseTo(1.35); // GROUND_CLEARANCE_FOOT
  expect(rig.shoulder).toBeCloseTo(0.85); // SHOULDER_FOOT
 });

 it("fov widens with speed01 toward baseFov * (1 + SPEED_FOV)", () => {
  const rig = makeRig();
  step(rig, 4, DT, 0, 1); // seconds of full speed
  expect(rig.fov).toBeCloseTo(1.02 * 1.19, 2); // FOV_BASE * (1 + SPEED_FOV)
 });

 it("fov stays at baseFov when stationary", () => {
  const rig = makeRig();
  step(rig, 2, DT, 0, 0);
  expect(rig.fov).toBeCloseTo(1.02, 5);
 });
});

describe("CameraRig roll easing", () => {
 it("roll eases toward -lean * ROLL_PER_LEAN, not instantly", () => {
  const rig = makeRig();
  rig.update(DT, FEET, VEL0, 1, 0);
  expect(rig.rollTarget).toBeCloseTo(-0.085); // -1 * ROLL_PER_LEAN
  expect(rig.roll).toBeLessThan(0);
  expect(Math.abs(rig.roll)).toBeLessThan(Math.abs(rig.rollTarget));
 });

 it("roll converges to rollTarget over time", () => {
  const rig = makeRig();
  step(rig, 5, DT, 1, 0);
  expect(rig.roll).toBeCloseTo(rig.rollTarget, 4);
 });

 it("lean sign drives roll sign", () => {
  const left = makeRig();
  const right = makeRig();
  step(left, 0.5, DT, -1, 0);
  step(right, 0.5, DT, 1, 0);
  expect(left.roll).toBeGreaterThan(0);
  expect(right.roll).toBeLessThan(0);
 });
});

describe("CameraRig getFlatForward / getFlatRight", () => {
 const cases: Array<[number, [number, number, number], [number, number, number]]> = [
  [0, [0, 0, 1], [1, 0, 0]],
  [Math.PI / 2, [1, 0, 0], [0, 0, -1]],
  [Math.PI, [0, 0, -1], [-1, 0, 0]],
  [-Math.PI / 2, [-1, 0, 0], [0, 0, 1]],
 ];
 for (const [yaw, fwd, right] of cases) {
  it(`yaw=${yaw.toFixed(4)} matches yaw trig`, () => {
   const rig = makeRig();
   rig.yaw = yaw;
   const f = rig.getFlatForward(new THREE.Vector3());
   const r = rig.getFlatRight(new THREE.Vector3());
   expect(f.x).toBeCloseTo(fwd[0], 6);
   expect(f.y).toBeCloseTo(0, 6);
   expect(f.z).toBeCloseTo(fwd[2], 6);
   expect(r.x).toBeCloseTo(right[0], 6);
   expect(r.y).toBeCloseTo(0, 6);
   expect(r.z).toBeCloseTo(right[2], 6);
  });
 }

 it("reuses the out vector", () => {
  const rig = makeRig();
  const out = new THREE.Vector3();
  expect(rig.getFlatForward(out)).toBe(out);
  expect(rig.getFlatRight(out)).toBe(out);
 });
});
