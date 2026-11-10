import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as THREE from "three";
import { Speeder } from "../src/player/speeder.js";
import { Jet } from "../src/player/jet.js";
import type { ModelAsset, ModelLOD } from "../src/player/modelAsset.js";
import { input } from "../src/core/input.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

const DT = 1 / 30;
const HOVER = 2.6;
const BOB_AMPLITUDE = 0.22;
const JET_HOVER = 0.14;
const JET_CRUISE = 0.30;
const JET_CRUISE_SPEED = 0.16;
const JET_REHEAT = 0.85;
const JET_REHEAT_SPEED = 0.45;
const JET_MAX = 1.55;

// ------------------------------------------------------------ test doubles

/**
 * Minimal hand-fabricated ModelAsset — one tiny LOD, one bone, clips null.
 * Nothing touches disk; the speeder only reads lods[0], the header's
 * bounds/basisScale/transScale/boneCount/materials/textureSize, and the
 * quantised anim run.
 */
function makeAsset(): ModelAsset {
  const lod: ModelLOD = {
    positions: new Float32Array([0, 0, 2.63, -1.1, 0, -2.63, 1.1, 0, -2.63]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    aux: new Float32Array([0, 0, 0, 0, 0, 0]),
    boneIdx: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    boneWt: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    indices: new Uint16Array([0, 1, 2]),
    triangleCount: 1,
    vertexCount: 3,
  };

  const header = {
    version: 2,
    layout: [],
    lods: [{ level: 0 }],
    posOffset: [0, 0, 0] as [number, number, number],
    posScale: [1, 1, 1] as [number, number, number],
    textureSize: 1,
    materials: [
      { name: "hull", slot: 0, roughness: 0.5, metallic: 0.1, albedoImage: 0, ormImage: 0 },
      { name: "interior", slot: 4, roughness: 0.5, metallic: 0.0, albedoImage: -1, ormImage: -1 },
    ],
    boneCount: 1,
    frameCount: 1,
    duration: 1,
    clips: null,
    // Read through a widen-until-declared supplement in the constructor.
    bounds: { min: [-1.1, -0.6, -2.63], max: [1.1, 0.6, 2.63] },
    basisScale: 1 / 1024,
    transScale: 1 / 1024,
  };
  return {
    header: header as unknown as ModelAsset["header"],
    lods: [lod],
    // One bone, identity basis, zero translation, quantised.
    anim: new Int16Array([1024, 0, 0, 0, 1024, 0, 0, 0, 1024, 0, 0, 0]),
    albedo: new Uint8Array(1 * 1 * 4 * 4),
    orm: new Uint8Array(1 * 1 * 4 * 4),
    clips: null,
    layers: 4,
    albedoSize: 1,
    ormSize: 1,
  };
}

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: number; order: number }> = [];
  let compiles = 0;
  const gfx = {
    addMesh(mesh: unknown, layer: number, order: number) {
      added.push({ mesh, layer, order });
    },
    LAYER: { OPAQUE: 1, BLEND: 2 },
    blackTex: new THREE.Texture(),
    whiteTex: new THREE.Texture(),
    scene: new THREE.Scene(),
    threeCamera: new THREE.Camera(),
    renderer: {
      capabilities: { getMaxAnisotropy: () => 4 },
      compileAsync: async () => {
        compiles++;
      },
    },
  };
  return { gfx, added, compiles: () => compiles };
}

const flatTerrain = () => ({ heightAt: () => 0 });

function makeShadows() {
  return {
    registerCaster: () => { },
    matrixValues: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
    splitsVec4: new THREE.Vector4(26, 95, 330, 330),
    paramData: new Float32Array(12),
    texelSize: 1 / 2048,
    maps: [new THREE.Texture(), new THREE.Texture(), new THREE.Texture()],
  };
}

interface ControllerLiteral {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  facing: number;
  lean: number;
  steerRate: number;
  speed01: number;
  speedRaw: number;
  climb: number;
  lift01: number;
  pathY: number;
  groundY: number;
  crashing: boolean;
  climbRate: number;
  driveHeld?: boolean;
  boostHeld?: boolean;
  fireHeld?: boolean;
}

/** The controller seam: a plain data literal, exactly as documented. */
function makeController(): ControllerLiteral {
  return {
    position: new THREE.Vector3(0, 5, 0),
    velocity: new THREE.Vector3(),
    facing: 0,
    lean: 0,
    steerRate: 0,
    speed01: 0,
    speedRaw: 0,
    climb: 0,
    lift01: 0,
    pathY: 0,
    groundY: 0,
    crashing: false,
    climbRate: 0,
  };
}

function makeSpeeder(
  terrain: { heightAt: (x: number, z: number) => number } = flatTerrain(),
  controller: ControllerLiteral = makeController(),
) {
  const { gfx, added, compiles } = makeGfx();
  const speeder = new Speeder(
    gfx as never,
    terrain as never,
    null as never, // sky: uniforms fall back to defaults
    makeShadows() as never,
    makeAsset(),
    controller,
  );
  return { speeder, added, compiles, controller, gfx };
}

function run(speeder: Speeder, seconds: number, dt = DT) {
  const steps = Math.floor(seconds / dt);
  for (let i = 0; i < steps; i++) speeder.update(dt);
}

const cam = () => new THREE.Vector3(0, 8, -12);

// ------------------------------------------------------------- save/restore

const INPUT_KEYS = [
  "moveX", "moveZ", "moving", "flying", "surf", "fire", "sprint",
  "riseLevel", "thrust", "boost", "vert",
] as const;
const S_KEYS = [
  "flightThrottle", "cinematicCam", "speederBankLead", "speederTurbulence",
  "speederStreak", "jetLength", "jetWidth", "jetFlare",
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
    speederStreak: 0.55,
    jetLength: 1.0,
    jetWidth: 1.0,
    jetFlare: 1.0,
  });
}

beforeAll(() => {
  registerShaders();
});

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
});

// ------------------------------------------------------------ construction

describe("Speeder construction", () => {
  it("registers the hull on the opaque layer and three plumes on blend", () => {
    const { added } = makeSpeeder();
    const opaque = added.filter((a) => a.layer === 1);
    const blend = added.filter((a) => a.layer === 2);
    expect(opaque.length).toBe(1);
    expect(blend.length).toBe(3); // main jet + two bottom repulsors
  });

  it("reads the fabricated header: bounds, one bone, triangle count", () => {
    const { speeder } = makeSpeeder();
    expect(speeder.boneCount).toBe(1);
    expect(speeder.bounds.max[2]).toBeCloseTo(2.63, 6);
    expect(speeder.triangles).toBe(1);
    expect(speeder.anim.length).toBe(12);
  });

  it("interior slot gets the 0.18 factor, painted slot the tint", () => {
    const { speeder } = makeSpeeder();
    expect(speeder.factors[0 + 3]).toBeCloseTo(S.speederTint as number, 6); // slot 0: tint
    expect(speeder.factors[16 + 3]).toBeCloseTo(0.18, 6); // slot 4: interior
  });
});

// ------------------------------------------------------------- hover / bob

describe("initial hover and bob", () => {
  it("snaps to roughly cruise height on the first update", () => {
    const { speeder } = makeSpeeder();
    speeder.update(DT);
    expect(speeder.position.y).toBeGreaterThan(HOVER - BOB_AMPLITUDE - 0.05);
    expect(speeder.position.y).toBeLessThan(HOVER + BOB_AMPLITUDE + 0.05);
  });

  it("wallows around cruise height at a standstill and never drops below the floor", () => {
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 0;
    controller.speedRaw = 0;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 300; i++) { // 10 s — over two bob periods
      speeder.update(DT);
      min = Math.min(min, speeder.position.y);
      max = Math.max(max, speeder.position.y);
    }
    expect(min).toBeGreaterThanOrEqual(1.2 - 1e-6); // HOVER_FLOOR over flat ground
    expect(min).toBeGreaterThan(HOVER - BOB_AMPLITUDE - 0.1);
    expect(max).toBeLessThan(HOVER + BOB_AMPLITUDE + 0.1);
    expect(max - min).toBeGreaterThan(0.15); // it really wallows
  });

  it("bob fades out with speed", () => {
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 1;
    controller.speedRaw = 19;
    controller.velocity.set(0, 0, 19);
    run(speeder, 3);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 240; i++) {
      speeder.update(DT);
      min = Math.min(min, speeder.position.y);
      max = Math.max(max, speeder.position.y);
    }
    // At speed01=1 the idle term is zero; only damped lift remains.
    expect(max - min).toBeLessThan(0.05);
  });

  it("rides higher with speed via the eased speed lift, and follows climb", () => {
    const slow = makeSpeeder();
    slow.controller.speed01 = 0;
    run(slow.speeder, 2);
    const fast = makeSpeeder();
    fast.controller.speed01 = 1;
    fast.controller.speedRaw = 19;
    run(fast.speeder, 4); // _liftSpeed eases at rate 1.3 — give it time
    expect(fast.speeder.position.y).toBeGreaterThan(slow.speeder.position.y + 1.0);

    const climbing = makeSpeeder();
    climbing.controller.climb = 6;
    climbing.speeder.update(DT);
    expect(climbing.speeder.position.y).toBeGreaterThan(HOVER + 5);
  });

  it("blends toward the controller's flattened path with lift01", () => {
    const { speeder, controller } = makeSpeeder();
    controller.lift01 = 1;
    controller.pathY = 40;
    speeder.update(DT);
    expect(speeder.position.y).toBeGreaterThan(40 + HOVER - 0.5);
  });

  it("a wreck lies in the snow: no hover, no bob, plume killed", () => {
    const { speeder } = makeSpeeder();
    speeder.grounded = true;
    speeder.setVisible(true);
    speeder.update(DT);
    expect(speeder.position.y).toBeCloseTo(-0.15, 6); // WRECK_BURY
    expect(speeder.jet.mesh.visible).toBe(false);
    expect(speeder.bottomJets.every((j) => !j.mesh.visible)).toBe(true);
  });
});

// ------------------------------------------------- attitude: roll and pitch

describe("roll into turns", () => {
  it("banks opposite the lean (negative lean→positive roll and back), scaled by BANK", () => {
    S.speederBankLead = 0; // isolate the lean term from the steer-rate lead
    const left = makeSpeeder();
    left.controller.lean = 1;
    left.controller.speed01 = 1; // idle = 0 → no common-mode bob roll
    run(left.speeder, 2);
    const right = makeSpeeder();
    right.controller.lean = -1;
    right.controller.speed01 = 1;
    run(right.speeder, 2);
    expect(left.speeder.roll).toBeLessThan(-0.4);
    expect(right.speeder.roll).toBeGreaterThan(0.4);
    expect(left.speeder.roll).toBeCloseTo(-right.speeder.roll, 5);
    expect(Math.abs(left.speeder.roll)).toBeLessThanOrEqual(0.62 + 1e-6); // BANK ceiling
  });

  it("steer-rate lead rolls further into the turn ahead of the lean", () => {
    S.cinematicCam = true;
    S.speederBankLead = 0.12;
    const still = makeSpeeder();
    still.controller.lean = 0.5;
    still.controller.steerRate = 0;
    run(still.speeder, 2);
    const leading = makeSpeeder();
    leading.controller.lean = 0.5;
    leading.controller.steerRate = 8;
    run(leading.speeder, 2);
    expect(leading.speeder.roll).toBeLessThan(still.speeder.roll);
  });
});

describe("pitch", () => {
  it("drops the nose under power, proportional to forward speed", () => {
    const parked = makeSpeeder();
    parked.controller.velocity.set(0, 0, 0);
    run(parked.speeder, 1);
    const cruising = makeSpeeder();
    cruising.controller.velocity.set(0, 0, 19); // PITCH_SPEED
    cruising.controller.speed01 = 1;
    run(cruising.speeder, 1);
    expect(cruising.speeder.pitch).toBeGreaterThan(parked.speeder.pitch);
    expect(cruising.speeder.pitch).toBeGreaterThan(0); // positive = nose down
  });

  it("a crash publishes its descent rate through the nose even outside the throttle scheme", () => {
    S.flightThrottle = false;
    const plain = makeSpeeder();
    plain.controller.crashing = false;
    plain.controller.climbRate = -7;
    run(plain.speeder, 2);
    const falling = makeSpeeder();
    falling.controller.crashing = true;
    falling.controller.climbRate = -7;
    run(falling.speeder, 2);
    expect(falling.speeder.pitch).toBeGreaterThan(plain.speeder.pitch + 0.2);
  });

  it("throttle scheme: positive climb rate pitches the nose up, dive rate past neutral pitches it down", () => {
    S.flightThrottle = true;
    const climbing = makeSpeeder();
    climbing.controller.climbRate = 7;
    run(climbing.speeder, 2);
    const diving = makeSpeeder();
    diving.controller.climbRate = -7;
    run(diving.speeder, 2);
    expect(climbing.speeder.pitch).toBeLessThan(diving.speeder.pitch);
    expect(diving.speeder.pitch).toBeGreaterThan(0.2); // DIVE_BIAS nose-down
  });
});


// ------------------------------------------- throttle / reheat via `input`

describe("throttle and reheat (flightThrottle scheme, input module stubbed)", () => {
  beforeEach(() => {
    S.flightThrottle = true;
    input.flying = true;
  });

  it("idle: plume sits at the hover stub fraction", () => {
    const { speeder } = makeSpeeder();
    run(speeder, 3);
    expect(speeder._throttle as number).toBeCloseTo(JET_HOVER, 2);
  });

  it("W (moving, no shift): cruise plume — basic jet, visibly running", () => {
    input.moving = true;
    input.moveZ = 1;
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 0;
    run(speeder, 4);
    expect(speeder._throttle as number).toBeCloseTo(JET_HOVER + JET_CRUISE, 2);
  });

  it("shift (reheat): plume stretches well past cruise and speed01 feeds it", () => {
    input.moving = true;
    input.sprint = true; // shift — the throttle, and what the plume reads
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 0.5;
    controller.speedRaw = 9.5;
    run(speeder, 4);
    const cruise = JET_HOVER + JET_CRUISE + JET_CRUISE_SPEED * 0.5;
    expect(speeder._throttle as number).toBeGreaterThan(cruise + 0.5);
    expect(speeder._throttle as number).toBeCloseTo(
      Math.min(JET_MAX, JET_HOVER + JET_CRUISE + JET_CRUISE_SPEED * 0.5
        + JET_REHEAT + JET_REHEAT_SPEED * 0.5), 2);
  });

  it("terminal velocity: the plume saturates at JET_MAX — more speed buys no more plume", () => {
    input.moving = true;
    input.sprint = true;
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 1;
    controller.speedRaw = 19;
    run(speeder, 5);
    expect(speeder._throttle as number).toBeCloseTo(JET_MAX, 2);
  });

  it("streak01 eases onto the boost and is zero without it", () => {
    input.moving = true;
    input.sprint = true;
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 1;
    controller.speedRaw = 19;
    run(speeder, 2);
    expect(speeder.streak01).toBeGreaterThan(0.3);

    input.sprint = false;
    run(speeder, 4); // slower off than on, but 4 s is plenty
    expect(speeder.streak01).toBeLessThan(0.05);
  });

  it("controller boostHeld overrides the keyboard (AI craft)", () => {
    const { speeder, controller } = makeSpeeder();
    controller.boostHeld = true;
    controller.driveHeld = true;
    controller.speed01 = 1;
    controller.speedRaw = 19;
    run(speeder, 5);
    expect(speeder._throttle as number).toBeCloseTo(JET_MAX, 2);
  });
});

// ---------------------------------------------------- bottom thrusters / E

describe("bottom repulsors", () => {
  it("light for 1 s on an E press, but only while going up", () => {
    S.flightThrottle = true;
    input.flying = true;
    input.boost = false;
    const { speeder, controller } = makeSpeeder();
    controller.climbRate = 3; // going up
    speeder.update(DT); // boot frame — seeds the edge detector
    input.boost = true; // E pressed
    speeder.update(DT); // rising edge of boost
    expect(speeder._bottomLightTimer as number).toBeGreaterThan(0.9);
    input.boost = false;
    run(speeder, 3); // 1 s light + ~2 s THROTTLE_OFF decay
    expect(speeder._bottomLightTimer as number).toBe(0);
    expect(speeder._bottomThrottle as number).toBeLessThan(0.05);
  });

  it("an E press while descending does nothing", () => {
    S.flightThrottle = true;
    input.flying = true;
    input.boost = false;
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 1; // kill the idle bob so only climbRate speaks
    controller.climbRate = -2; // descending
    run(speeder, 2); // let the lift settle so y is steady
    input.boost = true;
    speeder.update(DT);
    expect(speeder._bottomLightTimer ?? 0).toBe(0);
  });

  it("bottom plumes point down", () => {
    const { speeder } = makeSpeeder();
    for (const j of speeder.bottomJets) {
      expect(j._dirLocal.y).toBe(-1);
    }
    expect(speeder.jet._dirLocal.z).toBe(-1);
  });
});

// ------------------------------------------------------------- Jet itself

describe("Jet", () => {
  it("builds a 32-triangle, 36-vertex lattice with pinned bounds", () => {
    const { gfx } = makeGfx();
    const jet = new Jet(gfx as never);
    expect(jet.mesh.metadata.triangles).toBe(32);
    expect(jet.mesh.metadata.vertices).toBe(36);
    expect(jet.mesh.geometry.boundingSphere).not.toBeNull();
    expect((jet.mesh.geometry.boundingSphere as THREE.Sphere).radius).toBeGreaterThan(1e5);
  });

  it("places both nozzles off the world transform and aims down -z", () => {
    const { gfx } = makeGfx();
    const jet = new Jet(gfx as never);
    const world = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 5, 0]);
    jet.update(DT, world, { spanX: 0.42, dropY: -0.124, backZ: -2.63 }, 1, cam());
    expect(jet._origins[0]).toBeCloseTo(10 - 0.42, 5);
    expect(jet._origins[4]).toBeCloseTo(10 + 0.42, 5);
    expect(jet._origins[1]).toBeCloseTo(5 - 0.124, 5);
    expect(jet._origins[2]).toBeCloseTo(-2.63, 5);
    expect(jet._origins[3]).toBe(1);
    expect(jet._dir.z).toBeCloseTo(-1, 6);
    expect(jet._dir.w).toBeCloseTo(7.5 * (S.jetLength as number), 5);
  });

  it("a downward plume blows along -y regardless of craft yaw", () => {
    const { gfx } = makeGfx();
    const jet = new Jet(gfx as never, new THREE.Vector3(0, -1, 0));
    // 90° yaw about y: basis columns rotate, local -y stays world -y.
    const world = new Float32Array([0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, 0]);
    jet.update(DT, world, { spanX: 0.15, dropY: -0.5, backZ: -1.4 }, 0.5, cam());
    expect(jet._dir.x).toBeCloseTo(0, 6);
    expect(jet._dir.y).toBeCloseTo(-1, 6);
    expect(jet._dir.z).toBeCloseTo(0, 6);
  });

  it("plume length uniform tracks the throttle, scaled by jetLength/jetWidth settings", () => {
    const { gfx } = makeGfx();
    const jet = new Jet(gfx as never);
    const world = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    S.jetLength = 2;
    S.jetWidth = 3;
    jet.update(DT, world, { spanX: 0.42, dropY: -0.124, backZ: -2.63 }, 0.75, cam());
    expect(jet._params.x).toBe(0.75); // throttle passed straight through
    expect(jet._dir.w).toBeCloseTo(15, 5);
    expect(jet._params.z).toBeCloseTo(0.42 * 3, 5); // WIDTH * jetWidth
  });

  it("sync() feeds the eased speeder throttle into the plume", () => {
    input.moving = true;
    input.sprint = true;
    const { speeder, controller } = makeSpeeder();
    controller.speed01 = 1;
    controller.speedRaw = 19;
    run(speeder, 5);
    speeder.sync(cam());
    expect(speeder.jet._params.x).toBeCloseTo(speeder._throttle as number, 6);
    expect(speeder.jet._params.x).toBeCloseTo(JET_MAX, 2);
  });

  it("setVisible toggles the plume mesh", () => {
    const { gfx } = makeGfx();
    const jet = new Jet(gfx as never);
    jet.setVisible(false);
    expect(jet.mesh.visible).toBe(false);
    jet.setVisible(true);
    expect(jet.mesh.visible).toBe(true);
  });
});

// --------------------------------------------------------- warmUp contract

describe("warmUp is boot-only", () => {
  it("update() and sync() never touch the renderer; warmUp() compiles", async () => {
    input.moving = true;
    input.sprint = true;
    const { speeder, compiles } = makeSpeeder();
    for (let i = 0; i < 30; i++) speeder.update(DT);
    speeder.sync(cam());
    expect(compiles()).toBe(0);
    await speeder.warmUp();
    expect(compiles()).toBeGreaterThan(0);
  });
});
