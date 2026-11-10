/**
 * Cloth solver coverage: substep selection, verlet integration, constraint
 * convergence, pinned anchors, wind gust phase, hems over stub terrain and
 * long-run stability. Deterministic throughout: fixed dt, a heightfield stub,
 * an identity-skin figure stub, and `S.windStrength` saved/restored.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClothPanel, ClothSolver, makePanels } from "../src/character/cloth.js";
import type { Figure } from "../src/character/figure.js";
import { BONE_COUNT } from "../src/character/figure.js";
import type { CharacterController } from "../src/character/controller.js";
import { S } from "../src/core/settings.js";
import { GRAVITY } from "../src/spells/bending.js";

const FLOATS_PER_POINT = 3;
const MAT4_FLOATS = 16;
/** Robe hem rides this far above `heightAt` (mirrors the solver's clearance). */
const GROUND_CLEARANCE = 0.012;

/** Bind-pose joint positions (from the figure's bind table), for capsule checks. */
const BIND_JOINTS = new Float32Array([
  0, 0.95, 0, // ROOT
  0, 1.06, 0, // SPINE
  0, 1.26, 0, // CHEST
  0, 1.46, 0, // NECK
  0, 1.55, 0, // HEAD
  0, 1.55, 0, // HOOD
  -0.185, 1.4, 0, // UPPER_L
  -0.23, 1.123, 0, // FORE_L
  -0.243, 0.866, 0.016, // HAND_L
  0.185, 1.4, 0, // UPPER_R
  0.23, 1.123, 0, // FORE_R
  0.243, 0.866, 0.016, // HAND_R
  -0.1, 0.9, 0, // THIGH_L
  -0.1, 0.46, 0, // SHIN_L
  -0.1, 0.09, 0, // FOOT_L
  0.1, 0.9, 0, // THIGH_R
  0.1, 0.46, 0, // SHIN_R
  0.1, 0.09, 0, // FOOT_R
]);

/** Column-major identity skin for every bone → targets equal bind pose. */
function identitySkin(): Float32Array {
  const skin = new Float32Array(BONE_COUNT * MAT4_FLOATS);
  for (let b = 0; b < BONE_COUNT; b++) {
    const o = b * MAT4_FLOATS;
    skin[o + 0] = 1;
    skin[o + 5] = 1;
    skin[o + 10] = 1;
    skin[o + 15] = 1;
  }
  return skin;
}

/** Column-major pure-translation skin for every bone. */
function translationSkin(tx: number, ty: number, tz: number): Float32Array {
  const skin = identitySkin();
  for (let b = 0; b < BONE_COUNT; b++) {
    const o = b * MAT4_FLOATS;
    skin[o + 12] = tx;
    skin[o + 13] = ty;
    skin[o + 14] = tz;
  }
  return skin;
}

function makeFig(skin: Float32Array = identitySkin()): Figure {
  return { skin, joint: new Float32Array(BIND_JOINTS) } as unknown as Figure;
}

function makeCh(vx = 0, vy = 0, vz = 0): CharacterController {
  return { velocity: { x: vx, y: vy, z: vz } } as unknown as CharacterController;
}

/** Small deterministic test panel: 8-around × 4-down tube hanging from y = 1. */
function makeTestPanel(over: Partial<ConstructorParameters<typeof ClothPanel>[0]> = {}) {
  const cols = 8;
  const rows = 4;
  const p = new ClothPanel({
    name: "test", cols, rows, matId: 0,
    renderCols: 8, renderRows: 4,
    weaveU: 1, weaveV: 1,
    aoTop: 0, aoBottom: 0,
    collide: 0,
    ...over,
  });
  for (let j = 0; j < rows; j++) {
    const y = 1.0 - j * 0.15;
    for (let i = 0; i < cols; i++) {
      const a = (i / cols) * Math.PI * 2;
      const o = (j * cols + i) * FLOATS_PER_POINT;
      p.bindPos[o] = Math.sin(a) * 0.15;
      p.bindPos[o + 1] = y;
      p.bindPos[o + 2] = Math.cos(a) * 0.15;
      p.bone[j * cols + i] = 0;
    }
  }
  p.finalise();
  return p;
}

function linkLength(p: ClothPanel, a: number, b: number): number {
  const ia = a * FLOATS_PER_POINT, ib = b * FLOATS_PER_POINT;
  return Math.hypot(
    p.pos[ib] - p.pos[ia],
    p.pos[ib + 1] - p.pos[ia + 1],
    p.pos[ib + 2] - p.pos[ia + 2],
  );
}

const flatTerrain = (h: number) => ({ heightAt: () => h });

let savedWind: number;

beforeEach(() => {
  savedWind = S.windStrength as number;
  S.windStrength = 0; // deterministic: no gust terms unless a test opts in
});

afterEach(() => {
  S.windStrength = savedWind;
});

describe("makePanels construction", () => {
  it("returns the four garments with unique names and in-range material ids", () => {
    const panels = makePanels();
    expect(panels.map((p) => p.name)).toEqual(["robe", "mantle", "sleeve0", "sleeve1"]);
    for (const p of panels) {
      expect(p.matId).toBeGreaterThanOrEqual(0);
      expect(p.matId).toBeLessThanOrEqual(6);
      expect(p.count).toBe(p.cols * p.rows);
      expect(Number.isInteger(p.count)).toBe(true);
    }
  });

  it("sizes every backing array from cols × rows and copies bind pose into pos/prev", () => {
    for (const p of makePanels()) {
      expect(p.bindPos.length).toBe(p.count * 3);
      expect(p.pos.length).toBe(p.count * 3);
      expect(p.prev.length).toBe(p.count * 3);
      expect(p.target.length).toBe(p.count * 3);
      expect(p.bone.length).toBe(p.count);
      expect(p.pinRate.length).toBe(p.count);
      expect(p.restU.length).toBe(p.count);
      expect(p.restV.length).toBe(p.count);
      expect(p.restB.length).toBe(p.count);
      expect(Array.from(p.pos)).toEqual(Array.from(p.bindPos));
      expect(Array.from(p.prev)).toEqual(Array.from(p.bindPos));
    }
  });

  it("welded top rows, positive rest lengths, bones in range, bind pose finite", () => {
    for (const p of makePanels()) {
      for (let i = 0; i < p.cols; i++) {
        expect(p.pinRate[i]).toBe(Infinity); // row 0 welded to the skeleton
      }
      for (let k = 0; k < p.count; k++) {
        expect(Number.isFinite(p.bindPos[k * 3])).toBe(true);
        expect(Number.isFinite(p.bindPos[k * 3 + 1])).toBe(true);
        expect(Number.isFinite(p.bindPos[k * 3 + 2])).toBe(true);
        expect(p.bone[k]).toBeGreaterThanOrEqual(0);
        expect(p.bone[k]).toBeLessThan(BONE_COUNT);
        expect(p.restU[k]).toBeGreaterThan(0);
        expect(p.pinRate[k]).toBeGreaterThan(0); // every row pinned at least loosely
      }
      for (let j = 0; j < p.rows - 1; j++) {
        for (let i = 0; i < p.cols; i++) expect(p.restV[j * p.cols + i]).toBeGreaterThan(0);
      }
      for (let j = 0; j < p.rows - 2; j++) {
        for (let i = 0; i < p.cols; i++) expect(p.restB[j * p.cols + i]).toBeGreaterThan(0);
      }
    }
  });
});

class CountingSolver extends ClothSolver {
  steps = 0;
  override _step(p: ClothPanel, h: number, fig: Figure): void {
    this.steps++;
    super._step(p, h, fig);
  }
}

describe("substep selection", () => {
  const runWithDt = (dt: number) => {
    const solver = new CountingSolver([makeTestPanel()], flatTerrain(-100));
    solver.update(dt, makeFig(), makeCh());
    return solver;
  };

  it("takes a single sub-step at 60 Hz (below the split threshold)", () => {
    const solver = runWithDt(1 / 60);
    expect(solver.steps).toBe(1);
    expect(solver._t).toBeCloseTo(1 / 60, 10);
  });

  it("splits the frame in two once past SUBSTEP_MIN_H", () => {
    expect(runWithDt(0.5 / 55).steps).toBe(1); // below threshold: no split
    expect(runWithDt(1 / 54).steps).toBe(2); // above threshold: SPLIT_STEPS
  });

  it("takes two spans at 1/30 s with each half at 1/60", () => {
    expect(runWithDt(1 / 30).steps).toBe(2);
  });

  it("clamps a huge frame to the 30 Hz floor but still banks the raw dt in _t", () => {
    const solver = runWithDt(1);
    expect(solver.steps).toBe(2); // not a hundred steps — clamped to MAX_SUBSTEP_H, then split
    expect(solver._t).toBeCloseTo(1, 10);
  });

  it("steps every panel once per sub-step", () => {
    const panels = makePanels();
    const solver = new CountingSolver(panels, flatTerrain(-100));
    solver.update(1 / 30, makeFig(), makeCh());
    expect(solver.steps).toBe(panels.length * 2);
  });
});

describe("verlet gravity integration", () => {
  it("accelerates a particle from rest at ~g·h² in the first step", () => {
    const p = makeTestPanel(); // all pinRate 0 (free) by default
    const solver = new ClothSolver([p], flatTerrain(-100));
    const before = Array.from(p.pos);
    solver.update(1 / 60, makeFig(), makeCh());
    const h = 1 / 60;
    for (let k = 0; k < p.count; k++) {
      const o = k * FLOATS_PER_POINT;
      const drop = before[o + 1] - p.pos[o + 1];
      // gravity dominates; the small vertical gust term only trims it further
      expect(drop).toBeGreaterThan(GRAVITY * h * h * 0.99);
      expect(drop).toBeLessThanOrEqual(GRAVITY * h * h);
      expect(p.pos[o]).toBeCloseTo(before[o], 6);
      expect(p.pos[o + 2]).toBeCloseTo(before[o + 2], 6);
    }
  });

  it("builds velocity over successive steps — each drop is bigger than the last", () => {
    const p = makeTestPanel();
    const solver = new ClothSolver([p], flatTerrain(-100));
    const drops: number[] = [];
    let lastY = p.pos[1];
    for (let i = 0; i < 4; i++) {
      solver.update(1 / 60, makeFig(), makeCh());
      drops.push(lastY - p.pos[1]);
      lastY = p.pos[1];
    }
    expect(drops[1]).toBeGreaterThan(drops[0]);
    expect(drops[2]).toBeGreaterThan(drops[1]);
  });

  it("welded particles ignore gravity entirely", () => {
    const p = makeTestPanel();
    for (let k = 0; k < p.cols; k++) p.pinRate[k] = Infinity; // weld row 0
    const solver = new ClothSolver([p], flatTerrain(-100));
    const before = Array.from(p.pos);
    for (let i = 0; i < 30; i++) solver.update(1 / 60, makeFig(), makeCh());
    for (let k = 0; k < p.cols; k++) {
      const o = k * FLOATS_PER_POINT;
      expect(p.pos[o]).toBe(before[o]);
      expect(p.pos[o + 1]).toBe(before[o + 1]);
      expect(p.pos[o + 2]).toBe(before[o + 2]);
    }
  });
});

describe("constraint convergence", () => {
  it("restores a stretched ring link back toward its rest length", () => {
    const p = makeTestPanel();
    for (let k = 0; k < p.cols; k++) p.pinRate[k] = Infinity; // weld row 0
    const target = 2 * p.cols + 3; // a free particle on row 2
    const o = target * FLOATS_PER_POINT;

    // Stretch: push the particle radially 60% outward from the tube axis.
    p.pos[o] *= 1.6;
    p.pos[o + 2] *= 1.6;
    p.prev.set(p.pos);
    const next = target + 1; // ring wraps within the row since 3 < cols-1
    const prevIdx = target - 1;
    const strainBefore = Math.abs(linkLength(p, target, next) - p.restU[target]) / p.restU[target];
    expect(strainBefore).toBeGreaterThan(0.3); // sanity: the test is not vacuous

    const solver = new ClothSolver([p], flatTerrain(-100));
    for (let i = 0; i < 120; i++) solver.update(1 / 60, makeFig(), makeCh());

    expect(Math.abs(linkLength(p, target, next) - p.restU[target]) / p.restU[target]).toBeLessThan(0.25);
    expect(Math.abs(linkLength(p, target, prevIdx) - p.restU[prevIdx]) / p.restU[prevIdx]).toBeLessThan(0.25);
  });

  it("keeps an unstretched panel within reach of its rest shape across a long run", () => {
    const p = makeTestPanel();
    for (let k = 0; k < p.cols; k++) p.pinRate[k] = Infinity;
    const solver = new ClothSolver([p], flatTerrain(-100));
    for (let i = 0; i < 180; i++) solver.update(1 / 60, makeFig(), makeCh());
    // Down-column links in the welded-to-free ladder stay near rest.
    for (let j = 1; j < p.rows; j++) {
      for (let i = 0; i < p.cols; i++) {
        const k = (j - 1) * p.cols + i;
        const d = linkLength(p, k, k + p.cols);
        expect(Math.abs(d - p.restV[k]) / p.restV[k]).toBeLessThan(0.35);
      }
    }
  });
});

describe("pinned-row anchoring", () => {
  it("welded row stays exactly on the identity-skin target", () => {
    const panels = makePanels();
    const solver = new ClothSolver(panels, flatTerrain(-100));
    for (let i = 0; i < 90; i++) solver.update(1 / 60, makeFig(), makeCh());
    for (const p of panels) {
      for (let k = 0; k < p.cols; k++) {
        const o = k * FLOATS_PER_POINT;
        expect(p.pos[o]).toBe(p.bindPos[o]);
        expect(p.pos[o + 1]).toBe(p.bindPos[o + 1]);
        expect(p.pos[o + 2]).toBe(p.bindPos[o + 2]);
      }
    }
  });

  it("welded row tracks a translated skeleton exactly", () => {
    const panels = makePanels();
    const solver = new ClothSolver(panels, flatTerrain(-100));
    const t = [1.5, 2.5, -0.5] as const;
    const fig = makeFig(translationSkin(t[0], t[1], t[2]));
    for (let i = 0; i < 10; i++) solver.update(1 / 60, fig, makeCh());
    for (const p of panels) {
      for (let k = 0; k < p.cols; k++) {
        const o = k * FLOATS_PER_POINT;
        expect(p.pos[o]).toBeCloseTo(p.bindPos[o] + t[0], 6);
        expect(p.pos[o + 1]).toBeCloseTo(p.bindPos[o + 1] + t[1], 6);
        expect(p.pos[o + 2]).toBeCloseTo(p.bindPos[o + 2] + t[2], 6);
      }
    }
  });
});

describe("wind gust phase determinism", () => {
  it("two identical runs produce bitwise-identical wind and cloth state", () => {
    S.windStrength = 1;
    const run = () => {
      const panels = makePanels();
      const solver = new ClothSolver(panels, flatTerrain(-100));
      const ch = makeCh(6, 0, -4);
      const fig = makeFig();
      for (let i = 0; i < 120; i++) solver.update(1 / 60, fig, ch);
      return { solver, panels };
    };
    const A = run();
    const B = run();
    expect(A.solver._t).toBe(B.solver._t);
    expect(Array.from(A.solver._wind)).toEqual(Array.from(B.solver._wind));
    for (let pi = 0; pi < A.panels.length; pi++) {
      expect(Array.from(A.panels[pi].pos)).toEqual(Array.from(B.panels[pi].pos));
    }
  });

  it("advances _t by the raw frame dt and oscillates the vertical gust between samples", () => {
    S.windStrength = 1;
    const solver = new ClothSolver(makePanels(), flatTerrain(-100));
    const fig = makeFig();
    const ch = makeCh();
    const samples: number[] = [];
    for (let i = 0; i < 240; i++) {
      solver.update(1 / 60, fig, ch);
      samples.push(solver._wind[1]);
    }
    expect(solver._t).toBeCloseTo(4, 6);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(max - min).toBeGreaterThan(0.1); // the envelope genuinely breathes
  });

  it("with wind strength zero the apparent wind is exactly minus own velocity", () => {
    // beforeEach zeroes S.windStrength
    const solver = new ClothSolver(makePanels(), flatTerrain(-100));
    solver.update(1 / 60, makeFig(), makeCh(3, 0, 0));
    expect(solver._wind[0]).toBe(-3);
    expect(solver._wind[2]).toBe(0);
    // vertical gust term is independent of wind strength — do not assert it here
    solver.update(1 / 60, makeFig(), makeCh(0, 0, 0));
    expect(solver._wind[0]).toBe(0);
    expect(solver._wind[2]).toBe(0);
  });
});

describe("hems rest on stub terrain", () => {
  it("bottom rows ride a sloped snowfield without sinking through it", () => {
    const slope = { heightAt: (x: number, _z: number) => 1.2 + 0.3 * x };
    const panels = makePanels();
    const solver = new ClothSolver(panels, slope);
    const fig = makeFig();
    const ch = makeCh();
    for (let i = 0; i < 240; i++) solver.update(1 / 60, fig, ch);

    const robe = panels.find((p) => p.name === "robe")!;
    expect(robe.groundRows).toBeGreaterThan(0);
    const start = (robe.rows - robe.groundRows) * robe.cols;
    let resting = 0;
    for (let k = start; k < robe.count; k++) {
      const o = k * FLOATS_PER_POINT;
      const g = slope.heightAt(robe.pos[o], robe.pos[o + 2]) + GROUND_CLEARANCE;
      expect(robe.pos[o + 1]).toBeGreaterThanOrEqual(g - 1e-6);
      if (Math.abs(robe.pos[o + 1] - g) < 0.02) resting++;
    }
    expect(resting).toBeGreaterThan(0); // the hem actually found the snow, not just hovered
  });

  it("holds the clearance over a flat field far above the bind pose", () => {
    const panels = makePanels();
    const solver = new ClothSolver(panels, flatTerrain(1.2));
    const fig = makeFig();
    for (let i = 0; i < 120; i++) solver.update(1 / 60, fig, makeCh());
    const robe = panels.find((p) => p.name === "robe")!;
    const start = (robe.rows - robe.groundRows) * robe.cols;
    for (let k = start; k < robe.count; k++) {
      const o = k * FLOATS_PER_POINT;
      expect(robe.pos[o + 1]).toBeGreaterThanOrEqual(1.2 + GROUND_CLEARANCE - 1e-6);
    }
  });
});

describe("long-run stability", () => {
  it("no NaN or infinities anywhere after ten simulated seconds under wind and motion", () => {
    S.windStrength = 1;
    const panels = makePanels();
    const solver = new ClothSolver(panels, { heightAt: () => 0 });
    const fig = makeFig();
    const ch = makeCh(8, 0, -3);
    for (let i = 0; i < 300; i++) solver.update(1 / 30, fig, ch);
    expect(solver._t).toBeCloseTo(10, 6);
    for (const p of panels) {
      for (const arr of [p.pos, p.prev, p.target, p.bindPos, p.restU, p.restV, p.restB]) {
        for (let k = 0; k < arr.length; k++) expect(Number.isFinite(arr[k])).toBe(true);
      }
    }
    for (let k = 0; k < solver._wind.length; k++) expect(Number.isFinite(solver._wind[k])).toBe(true);
  });
});

describe("capsule collision", () => {
  it("pushes a free robe particle out of the torso capsule", () => {
    const panels = makePanels();
    const robe = panels.find((p) => p.name === "robe")!;
    const j = 7; // free row (pinRate 0.4)
    const k = j * robe.cols;
    const o = k * FLOATS_PER_POINT;
    robe.pos[o] = 0; // straight down the torso axis
    robe.pos[o + 1] = 1.1;
    robe.pos[o + 2] = 0;
    robe.prev.set(robe.pos);
    const solver = new ClothSolver(panels, flatTerrain(-100));
    solver.update(1 / 60, makeFig(), makeCh());
    const perp = Math.hypot(robe.pos[o], robe.pos[o + 2]);
    expect(perp).toBeGreaterThanOrEqual(0.175 - 1e-4);
  });
});
