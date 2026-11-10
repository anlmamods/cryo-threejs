import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import * as THREE from "three";
import { SpellSystem } from "../src/spells/spellSystem.js";
import { input } from "../src/core/input.js";
import { S } from "../src/core/settings.js";
import { registerShaders } from "../src/shaders/registry.js";

const DT = 1 / 30;

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: number; order: number }> = [];
  const gfx = {
    addMesh(mesh: THREE.Mesh, layer: number, order: number) {
      added.push({ mesh, layer, order });
    },
    LAYER: { OPAQUE: 1, BLEND: 2 },
    blackTex: new THREE.Texture(),
    whiteTex: new THREE.Texture(),
  };
  return { gfx, added };
}

function makeTerrain() {
  return {
    heightAt: (_x: number, _z: number) => 0,
    deform: { brush: vi.fn() },
  };
}

interface RigStub {
  forward: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  camera: { position: THREE.Vector3; viewProjection: THREE.Matrix4 };
  trauma: number;
  addTrauma(n: number): void;
}

function makeRig(forward = new THREE.Vector3(0, 0, 1)): RigStub {
  const rig = {
    forward: forward.clone(),
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    camera: {
      position: new THREE.Vector3(4, 2, -3),
      viewProjection: new THREE.Matrix4(),
    },
    trauma: 0,
    addTrauma(n: number) {
      this.trauma += n;
    },
  };
  return rig;
}

function makeController() {
  return {
    position: new THREE.Vector3(10, 2, -3),
    facing: 0,
    cast: 0,
    castAimX: 0,
    castAimY: 0,
    castAimZ: 0,
  };
}

function makeSpray() {
  return { emit: vi.fn() };
}

function makeFigure() {
  return {
    handPosition: vi.fn((_which: number, out: Float32Array, off: number) => {
      out[off] = 111;
      out[off + 1] = 222;
      out[off + 2] = 333;
    }),
  };
}

function makeSystem(opts: { figure?: unknown; rig?: RigStub } = {}) {
  const { gfx, added } = makeGfx();
  const terrain = makeTerrain();
  const rig = opts.rig ?? makeRig();
  const controller = makeController();
  const spray = makeSpray();
  const figure = opts.figure === undefined ? null : opts.figure;
  const system = new SpellSystem(
    gfx as never,
    null as never,
    null as never,
    terrain as never,
    controller as never,
    figure as never,
    rig as never,
    spray as never,
  );
  return { system, terrain, rig, controller, spray, added };
}

const S_KEYS = ["showSpells", "showCharacter"] as const;
const INPUT_KEYS = ["spellPressed", "spellHeld2"] as const;
const savedS = new Map<string, unknown>();
const savedInput = new Map<string, unknown>();

beforeAll(() => {
  registerShaders();
});

beforeEach(() => {
  savedS.clear();
  savedInput.clear();
  for (const k of S_KEYS) savedS.set(k, (S as Record<string, unknown>)[k]);
  for (const k of INPUT_KEYS) savedInput.set(k, (input as Record<string, unknown>)[k]);
  Object.assign(S, { showSpells: true, showCharacter: true });
  Object.assign(input, { spellPressed: 0, spellHeld2: false });
});

afterEach(() => {
  for (const k of S_KEYS) (S as Record<string, unknown>)[k] = savedS.get(k);
  for (const k of INPUT_KEYS) (input as Record<string, unknown>)[k] = savedInput.get(k);
  vi.restoreAllMocks();
});

describe("SpellSystem construction", () => {
  it("registers the water and crystal meshes and starts with nothing cast", () => {
    const { system, added } = makeSystem();
    expect(added.length).toBe(2);
    expect(system.castCount).toBe(0);
    expect(system.lastCast).toBe(0);
    expect(system.spells.length).toBe(5);
    expect(system.sweep.active).toBe(false);
    expect(system.ribbon.active).toBe(false);
    expect(system.bloom.active).toBe(false);
    expect(system.crystallize.active).toBe(false);
    expect(system.vortex.active).toBe(false);
  });
});

describe("SpellSystem._dispatch input validation", () => {
  it.each([0, 6, Number.NaN, -1])(
    "spellPressed = %s fires nothing and leaves castCount unmoved",
    (key) => {
      const { system } = makeSystem();
      input.spellPressed = key;
      system._dispatch();
      expect(system.castCount).toBe(0);
      expect(system.lastCast).toBe(0);
      for (const s of system.spells) expect(s.active).toBe(false);
      expect(system.ribbon.held).toBe(false);
    },
  );

  it("spellPressed = 1 dispatches the Sweep", () => {
    const { system } = makeSystem();
    input.spellPressed = 1;
    system._dispatch();
    expect(system.sweep.active).toBe(true);
    expect(system.castCount).toBe(1);
    expect(system.lastCast).toBe(1);
  });

  it("does not dispatch while S.showSpells is false (update cancels instead)", () => {
    const { system } = makeSystem();
    S.showSpells = false;
    input.spellPressed = 1;
    system.update(DT, new THREE.Vector3(0, 5, 0));
    expect(system.castCount).toBe(0);
    expect(system.sweep.active).toBe(false);
  });

  it("spellHeld2 holds the ribbon through _dispatch", () => {
    const { system } = makeSystem();
    input.spellHeld2 = true;
    system._dispatch();
    expect(system.ribbon.held).toBe(true);
    expect(system.ribbon.active).toBe(true);
    expect(system.lastCast).toBe(2);
  });
});

describe("SpellSystem.cast dispatch", () => {
  it("cast(1) fires the Sweep with flat aim and applies sweep trauma", () => {
    const { system, rig } = makeSystem();
    system.cast(1);
    expect(system.sweep.active).toBe(true);
    expect(system.bloom.active).toBe(false);
    expect(system.vortex.active).toBe(false);
    expect(rig.trauma).toBeCloseTo(0.12, 6);
    expect(system.lastCast).toBe(1);
    expect(system.castCount).toBe(1);
  });

  it("cast(2) holds the ribbon and bumps the count through holdRibbon", () => {
    const { system, rig } = makeSystem();
    system.cast(2);
    expect(system.ribbon.held).toBe(true);
    expect(system.ribbon.active).toBe(true);
    expect(rig.trauma).toBe(0);
    expect(system.castCount).toBe(1);
    expect(system.lastCast).toBe(2);
  });

  it("cast(3) fires the Bloom at the aimed ground point, no trauma", () => {
    const { system, rig } = makeSystem();
    system.aim.set(0, -1, 0);
    system.cast(3);
    expect(system.bloom.active).toBe(true);
    expect(rig.trauma).toBe(0);
    expect(system.lastCast).toBe(3);
    expect(system.castCount).toBe(1);
  });

  it("cast(4) fires the Crystallize and paints the glaze brushes", () => {
    const { system, terrain, rig } = makeSystem();
    system.aim.set(0, -1, 0);
    system.cast(4);
    expect(system.crystallize.active).toBe(true);
    expect(terrain.deform.brush).toHaveBeenCalled();
    expect(rig.trauma).toBe(0);
    expect(system.lastCast).toBe(4);
    expect(system.castCount).toBe(1);
  });

  it("cast(5) fires the Vortex and applies vortex trauma", () => {
    const { system, rig } = makeSystem();
    system.cast(5);
    expect(system.vortex.active).toBe(true);
    expect(rig.trauma).toBeCloseTo(0.1, 6);
    expect(system.lastCast).toBe(5);
    expect(system.castCount).toBe(1);
  });

  it("castCount is monotonic and lastCast tracks the most recent key", () => {
    const { system } = makeSystem();
    const seen: number[] = [];
    for (const key of [1, 3, 4, 5, 2]) {
      system.cast(key);
      seen.push(system.castCount);
      expect(system.lastCast).toBe(key);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(system.castCount).toBe(5);
  });
});

describe("SpellSystem.holdRibbon", () => {
  it("forwards hold state to the ribbon", () => {
    const { system } = makeSystem();
    system.holdRibbon(true);
    expect(system.ribbon.held).toBe(true);
    expect(system.ribbon.active).toBe(true);
    system.holdRibbon(false);
    expect(system.ribbon.held).toBe(false);
  });

  it("a repeated hold(true) while held does not double-count the cast", () => {
    const { system } = makeSystem();
    system.holdRibbon(true);
    system.holdRibbon(true);
    expect(system.castCount).toBe(1);
    expect(system.lastCast).toBe(2);
  });
});

describe("SpellSystem._cancelAll", () => {
  it("deactivates every spell including a held ribbon", () => {
    const { system } = makeSystem();
    for (const key of [1, 2, 3, 4, 5]) system.cast(key);
    system._cancelAll();
    expect(system.sweep.active).toBe(false);
    expect(system.ribbon.active).toBe(false);
    expect(system.ribbon.held).toBe(false);
    expect(system.bloom.active).toBe(false);
    expect(system.crystallize.active).toBe(false);
    expect(system.vortex.active).toBe(false);
  });
});

describe("SpellSystem._handPosition", () => {
  it("falls back in front of the chest when the figure is null", () => {
    const { system, controller } = makeSystem({ figure: null });
    controller.position.set(10, 2, -3);
    controller.facing = 0;
    const out = new Float32Array(3);
    // left hand: side = -HAND_SIDE
    system._handPosition(0, out, 0);
    expect(out[0]).toBeCloseTo(10 - 0.28, 6);
    expect(out[1]).toBeCloseTo(2 + 1.25, 6);
    expect(out[2]).toBeCloseTo(-3 + 0.35, 6);
    // right hand: side = +HAND_SIDE
    system._handPosition(1, out, 0);
    expect(out[0]).toBeCloseTo(10 + 0.28, 6);
    expect(out[1]).toBeCloseTo(2 + 1.25, 6);
    expect(out[2]).toBeCloseTo(-3 + 0.35, 6);
  });

  it("rotates the fallback offset with facing", () => {
    const { system, controller } = makeSystem({ figure: null });
    controller.position.set(0, 0, 0);
    controller.facing = Math.PI / 2; // fx = 1, fz ≈ 0
    const out = new Float32Array(3);
    system._handPosition(1, out, 0);
    expect(out[0]).toBeCloseTo(0.35, 6);
    expect(out[2]).toBeCloseTo(-0.28, 6);
  });

  it("falls back when the figure exists but S.showCharacter is false", () => {
    const figure = makeFigure();
    const { system } = makeSystem({ figure });
    S.showCharacter = false;
    const out = new Float32Array(3);
    system._handPosition(1, out, 0);
    expect(figure.handPosition).not.toHaveBeenCalled();
    expect(out[0]).toBeCloseTo(10 + 0.28, 6);
    expect(out[1]).toBeCloseTo(2 + 1.25, 6);
  });

  it("delegates to the figure when one is shown", () => {
    const figure = makeFigure();
    const { system } = makeSystem({ figure });
    const out = new Float32Array(3);
    system._handPosition(0, out, 0);
    expect(figure.handPosition).toHaveBeenCalledWith(0, out, 0);
    expect(out[0]).toBe(111);
    expect(out[1]).toBe(222);
    expect(out[2]).toBe(333);
  });
});

describe("SpellSystem aim raycast", () => {
  it("falls back to AIM_FALLBACK metres ahead on a terrain miss", () => {
    // Aim tilted upward: the ray never descends to the flat terrain, so
    // aimPoint must land the spell at the fallback distance in front.
    const rig = makeRig(new THREE.Vector3(0, 0.8, 0.6));
    const { system } = makeSystem({ rig });
    system.update(DT, new THREE.Vector3(0, 5, 0));
    system.cast(3);
    expect(system.bloom.active).toBe(true);
    expect(system.bloom.x).toBeCloseTo(4, 5); // eye.x + horizontal dir x * 13
    expect(system.bloom.z).toBeCloseTo(-3 + 13, 5); // eye.z + normalized dir z * 13
    expect(system.bloom.y).toBeCloseTo(0, 5); // dropped onto the surface
  });

  it("lands the Bloom on the terrain when the ray hits", () => {
    const rig = makeRig(new THREE.Vector3(0, -1, 0));
    const { system } = makeSystem({ rig });
    system.update(DT, new THREE.Vector3(0, 5, 0));
    system.cast(3);
    expect(system.bloom.active).toBe(true);
    expect(system.bloom.x).toBeCloseTo(4, 1);
    expect(system.bloom.y).toBeCloseTo(0, 1);
    expect(system.bloom.z).toBeCloseTo(-3, 1);
  });
});

describe("SpellSystem.update", () => {
  it("writes the casting stance onto the controller", () => {
    const { system, controller } = makeSystem();
    system.update(DT, new THREE.Vector3(0, 5, 0));
    expect(typeof controller.cast).toBe("number");
    expect(controller.castAimX).toBeCloseTo(system.aim.x, 6);
    expect(controller.castAimY).toBeCloseTo(system.aim.y, 6);
    expect(controller.castAimZ).toBeCloseTo(system.aim.z, 6);
  });
});
