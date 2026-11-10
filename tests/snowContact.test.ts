import { describe, it, expect, afterEach, vi } from "vitest";
import { SnowContact } from "../src/character/snowContact.js";
import { RUN_SPEED } from "../src/character/controller.js";
import type { CharacterController } from "../src/character/controller.js";
import type { DeformationField } from "../src/terrain/deformation.js";
import type { Figure } from "../src/character/figure.js";
import type { SprayField } from "../src/vfx/particles.js";
import { input } from "../src/core/input.js";

/** Fake controller literal — only the fields SnowContact reads. */
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
    lift01: 0,
    groundY: 0,
    ...over,
  }) as unknown as CharacterController;

const countingField = () => {
  const brush = vi.fn();
  const field = { brush } as unknown as DeformationField;
  return { field, brush };
};

const countingSpray = () => {
  const emit = vi.fn();
  const spray = { emit } as unknown as SprayField;
  return { spray, emit };
};

/** brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge) */
const brushArgs = (call: unknown[]) => ({
  x: call[0] as number,
  z: call[1] as number,
  radius: call[2] as number,
  depth: call[3] as number,
  berm: call[4] as number,
  compression: call[5] as number,
  ice: call[6] as number,
  yaw: call[7] as number,
  elongation: call[8] as number,
  edge: call[9] as number,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SnowContact null-field behavior", () => {
  it("is a no-op when the field is null, even with a footfall", () => {
    const ch = fakeController({ speed: 2, footfall: true, footIndex: 1, footPos: { x: 1, z: 1 } });
    const sc = new SnowContact(ch, null, null, null);
    expect(() => sc.update(1 / 60)).not.toThrow();
    ch.position.x += 1;
    expect(() => sc.update(1 / 60)).not.toThrow();
  });

  it("stamps prints and swallows spray when spray is null", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 0, footfall: true, footIndex: 1, footPos: { x: 4, z: 5 } });
    const sc = new SnowContact(ch, field, null, null);
    expect(() => sc.update(1 / 60)).not.toThrow();
    expect(brush).toHaveBeenCalledTimes(1);
    expect(brushArgs(brush.mock.calls[0]).x).toBe(4);
  });
});

describe("SnowContact walking scuff (distance-scaled)", () => {
  it("scales brush depth by distance travelled, saturating at SCUFF_MAX_DIST (0.35 m)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 1.0 });
    const sc = new SnowContact(ch, field, null, null);

    sc.update(1 / 60); // no movement yet → zero-depth brush
    let a = brushArgs(brush.mock.calls[0]);
    expect(a.depth).toBe(0);
    expect(a.radius).toBeCloseTo(0.22, 6);

    ch.position.z += 0.1;
    sc.update(1 / 60);
    a = brushArgs(brush.mock.calls[1]);
    expect(a.depth).toBeCloseTo(0.20 * 0.1, 6); // SCUFF_DEPTH * moved

    ch.position.z += 1.0; // more than the 0.35 m saturation window
    sc.update(1 / 60);
    a = brushArgs(brush.mock.calls[2]);
    expect(a.depth).toBeCloseTo(0.20 * 0.35, 6);
    expect(a.berm).toBeCloseTo(0.22 * 0.35, 6);
    expect(a.compression).toBeCloseTo(0.8 * 0.35, 6);
    expect(a.elongation).toBeCloseTo(1.5, 6);
    expect(a.edge).toBeCloseTo(0.85, 6);
    expect(a.ice).toBe(0);
  });

  it("bores no hole while standing still (speed < SCUFF_MIN_SPEED)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 0.1 });
    const sc = new SnowContact(ch, field, null, null);
    sc.update(1 / 60);
    ch.position.z += 0.5; // even moving, too slow to scuff
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("walking scuff fades out as surf blend approaches 1", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 3.0, surf: 0.99, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    // surf >= FOOT_SURF_CEIL (0.98) → walk path suppressed; surf path fires instead.
    const radii = brush.mock.calls.map((c) => brushArgs(c).radius);
    expect(radii).not.toContain(0.22);
  });
});

describe("SnowContact surf wake", () => {
  it("emits groove + two berms only when surf is above the floor and speed is up", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 1, speed: 6, speed01: 1, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    expect(brush).toHaveBeenCalledTimes(3); // groove + left berm + right berm
    const [groove, bermL, bermR] = brush.mock.calls.map(brushArgs);
    expect(groove.radius).toBeCloseTo(0.3, 6); // surfWidth (1.0) * SURF_WIDTH, fast=0 at 6 m/s
    expect(groove.depth).toBeCloseTo(1.2 * 0.1, 6); // WAKE_DEPTH * moved * surf * speedK
    expect(groove.elongation).toBeCloseTo(2.6, 6);
    expect(bermL.depth).toBe(0); // berms carry throw in the berm channel
    expect(bermL.berm).toBeGreaterThan(0);
    expect(bermR.berm).toBeCloseTo(bermL.berm, 6); // centred carve → symmetric
    expect(bermL.x).toBeCloseTo(-bermR.x, 6); // berms flank the groove
  });

  it("does nothing below the wake gain floor (speed < 0.3 m/s)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 1, speed: 0.1, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("lift01 = 1 pulls all downwash off the field (no wake at altitude)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 1, speed: 6, lift01: 1, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("a hovering craft (input.flying) at altitude writes no wake", () => {
    // input.flying is a module singleton; flip it just for this test.
    const prev = input.flying;
    input.flying = true;
    try {
      const { field, brush } = countingField();
      const ch = fakeController({ surf: 1, speed: 6, lift01: 0, position: { x: 0, y: 10, z: 0 }, groundY: 0 });
      const sc = new SnowContact(ch, field, null, null);
      ch.position.z += 0.1;
      sc.update(1 / 60);
      // 10 m clearance is past CRAFT_CLEAR_BASE + CRAFT_CLEAR_RANGE → zero effect.
      expect(brush).not.toHaveBeenCalled();
    } finally {
      input.flying = prev;
    }
  });

  it("widen factor grows the groove with speed (fast term)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 1, speed: 18, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    const groove = brushArgs(brush.mock.calls[0]);
    // fast = min(1, (18-6)/12) = 1 → radius = 0.3 * (1 + 0.35)
    expect(groove.radius).toBeCloseTo(0.3 * 1.35, 6);
  });

  it("mid surf blend runs both walk and surf paths", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 0.5, speed: 6, position: { x: 0, y: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    const radii = brush.mock.calls.map((c) => brushArgs(c).radius);
    expect(radii).toContain(0.22); // walking scuff radius present
    expect(radii).toContain(0.3);  // surf groove radius present
  });
});

describe("SnowContact footfall prints", () => {
  it("stamps one print under the right boot from the controller footfall event", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 0, footfall: true, footIndex: 1, footPos: { x: 7, z: 8 }, facing: 0.5 });
    const sc = new SnowContact(ch, field, null, null);
    sc.update(1 / 60);
    expect(brush).toHaveBeenCalledTimes(1);
    const a = brushArgs(brush.mock.calls[0]);
    expect(a.x).toBe(7);
    expect(a.z).toBe(8);
    expect(a.radius).toBeCloseTo(0.10, 6);       // BOOT_WIDTH
    expect(a.elongation).toBeCloseTo(1.7, 6);    // BOOT_ELONG
    expect(a.compression).toBeCloseTo(0.9, 6);   // BOOT_COMPRESS
    expect(a.edge).toBeCloseTo(1.0, 6);          // BOOT_EDGE
    expect(a.yaw).toBe(0.5);                     // ch.facing
    expect(a.depth).toBeCloseTo(0.17 + 0.14 * 0.35, 6); // rest depth + impact at speed 0
    expect(a.berm).toBeCloseTo(0.10 + 0.08 * 0.35, 6);
  });

  it("stamps under the left boot when footIndex is 0", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 0, footfall: true, footIndex: 0, footPos: { x: -3, z: 2 } });
    const sc = new SnowContact(ch, field, null, null);
    sc.update(1 / 60);
    expect(brush).toHaveBeenCalledTimes(1);
    expect(brushArgs(brush.mock.calls[0]).x).toBe(-3);
  });

  it("footfall with an out-of-range footIndex stamps nothing", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 0, footfall: true, footIndex: 5, footPos: { x: 1, z: 1 } });
    const sc = new SnowContact(ch, field, null, null);
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("figure path stamps nothing while stepping is false, even on touchdown", () => {
    const { field, brush } = countingField();
    const plant = new Float32Array(6);
    const fig = { touchdown: [true, true], plant } as unknown as Figure;
    const ch = fakeController({ speed: 0, stepping: false });
    const sc = new SnowContact(ch, field, fig, null);
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("uses the figure's touchdown + plant when a figure is present (right boot)", () => {
    const { field, brush } = countingField();
    const plant = new Float32Array([1, 0.05, 2, 3, 0.06, 4]);
    const fig = { touchdown: [false, true], plant } as unknown as Figure;
    const ch = fakeController({ speed: 0, stepping: true, footfall: false });
    const sc = new SnowContact(ch, field, fig, null);
    sc.update(1 / 60);
    expect(brush).toHaveBeenCalledTimes(1);
    const a = brushArgs(brush.mock.calls[0]);
    expect(a.x).toBe(3); // plant of foot 1
    expect(a.z).toBe(4);
  });

  it("uses the left plant when only the left foot touches down", () => {
    const { field, brush } = countingField();
    const plant = new Float32Array([-2, 0.05, -6, 3, 0.06, 4]);
    const fig = { touchdown: [true, false], plant } as unknown as Figure;
    const ch = fakeController({ speed: 0, stepping: true });
    const sc = new SnowContact(ch, field, fig, null);
    sc.update(1 / 60);
    expect(brush).toHaveBeenCalledTimes(1);
    expect(brushArgs(brush.mock.calls[0]).x).toBe(-2);
    expect(brushArgs(brush.mock.calls[0]).z).toBe(-6);
  });

  it("figure path stays silent when no foot is touching down", () => {
    const { field, brush } = countingField();
    const plant = new Float32Array(6);
    const fig = { touchdown: [false, false], plant } as unknown as Figure;
    const ch = fakeController({ speed: 0, stepping: true, footfall: true, footIndex: 1, footPos: { x: 9, z: 9 } });
    const sc = new SnowContact(ch, field, fig, null);
    sc.update(1 / 60);
    expect(brush).not.toHaveBeenCalled();
  });

  it("footfall prints still stamp while surfing (footfalls are mode-agnostic)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ surf: 1, speed: 6, footfall: true, footIndex: 1, footPos: { x: 2, z: 2 } });
    const sc = new SnowContact(ch, field, null, null);
    ch.position.z += 0.1;
    sc.update(1 / 60);
    const radii = brush.mock.calls.map((c) => brushArgs(c).radius);
    expect(radii).toContain(0.10); // boot print among the surf brushes
  });

  it("impact saturates: print depth caps at FOOT_IMPACT_MAX (1.3)", () => {
    const { field, brush } = countingField();
    const ch = fakeController({ speed: 2 * RUN_SPEED, footfall: true, footIndex: 1, footPos: { x: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, null);
    sc.update(1 / 60);
    const print = brush.mock.calls.map(brushArgs).find((a) => Math.abs(a.radius - 0.1) < 1e-9);
    expect(print).toBeDefined();
    expect(print!.depth).toBeCloseTo(0.17 + 0.14 * 1.3, 6);
    expect(print!.berm).toBeCloseTo(0.10 + 0.08 * 1.3, 6);
  });
});

describe("SnowContact spray kick", () => {
  it("emits KICK_GRAINS + impact*KICK_GRAINS_IMPACT grains per footfall, deterministic with stubbed random", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { field } = countingField();
    const { spray, emit } = countingSpray();
    const ch = fakeController({ speed: 1.0, footfall: true, footIndex: 1, footPos: { x: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, spray);
    sc.update(1 / 60);
    // impact = min(1.3, 0.35 + 1/5.4) ≈ 0.535 → n = 6 + floor(0.535 * 14) = 13
    const impact = Math.min(1.3, 0.35 + 1.0 / RUN_SPEED);
    const n = 6 + ((impact * 14) | 0);
    expect(emit).toHaveBeenCalledTimes(n);
  });

  it("carried fraction of body velocity lands in the throw (facing 0 → full vz, vx from fx)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { field } = countingField();
    const { spray, emit } = countingSpray();
    const ch = fakeController({ speed: 1.0, facing: 0, velocity: { x: 2, z: 4 }, footfall: true, footIndex: 1, footPos: { x: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, spray);
    sc.update(1 / 60);
    expect(emit).toHaveBeenCalled();
    for (const call of emit.mock.calls) {
      // facing 0 → fx = 0 → vx reduces to the inherited term
      expect(call[3]).toBeCloseTo(2 * 0.25, 6);
      // vz = -fz * back + scatter + inherited; rz = 0 with random=0.5
      const impact = Math.min(1.3, 0.35 + 1.0 / RUN_SPEED);
      const back = 0.5 + 0.5 * 1.6 * impact;
      expect(call[5]).toBeCloseTo(-back + 4 * 0.25, 6);
      // random 0.5 → powder grain, vy = (0.9 + 0.5*1.9) * POWDER_UP
      expect(call[4]).toBeCloseTo(0.9 + 0.5 * 1.9, 6);
      expect(call[8]).toBe(0); // clod flag false
    }
  });

  it("clod branch: random() < KICK_CLOD_CHANCE launches heavier, faster-rising grains", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const { field } = countingField();
    const { spray, emit } = countingSpray();
    const ch = fakeController({ speed: 1.0, facing: 0, velocity: { x: 0, z: 0 }, footfall: true, footIndex: 1, footPos: { x: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, spray);
    sc.update(1 / 60);
    expect(emit).toHaveBeenCalled();
    for (const call of emit.mock.calls) {
      expect(call[8]).toBe(1); // clod
      expect(call[4]).toBeCloseTo((0.9 + 0.1 * 1.9) * 1.25, 6); // up * CLOD_UP
      expect(call[6]).toBeCloseTo(0.014 + 0.1 * 0.012, 6);      // CLOD_SIZE_BASE + rise
    }
  });

  it("throws nothing below KICK_MIN_SPEED (0.4 m/s) even on a footfall", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { field, brush } = countingField();
    const { spray, emit } = countingSpray();
    const ch = fakeController({ speed: 0.3, footfall: true, footIndex: 1, footPos: { x: 0, z: 0 } });
    const sc = new SnowContact(ch, field, null, spray);
    sc.update(1 / 60);
    const print = brush.mock.calls.map(brushArgs).find((a) => Math.abs(a.radius - 0.1) < 1e-9);
    expect(print).toBeDefined(); // print still stamped
    expect(emit).not.toHaveBeenCalled();    // but no grains thrown
  });
});
