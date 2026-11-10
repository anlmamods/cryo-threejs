import { describe, it, expect, vi, afterEach } from "vitest";
import * as THREE from "three";
import { Excavation } from "../src/mining/excavation.js";
import { MAT_EMPTY, worldToVoxel } from "../src/mining/voxelGrid.js";
import { pitMaskUniforms, PIT_MASK_WINDOW, PIT_MASK_RES } from "../src/terrain/pitMask.js";
import type { Mock } from "vitest";
import type { Gfx } from "../src/core/gfx.js";
import type { Terrain } from "../src/terrain/terrain.js";
import type { DepthPass } from "../src/render/depthPass.js";
import type { ShadowSystem } from "../src/render/shadows.js";
import type { Sky } from "../src/render/sky.js";

// ---------------------------------------------------------------- stubs

type Handler = (...args: never[]) => void;

interface StubbedGlobals {
 winHandlers: Record<string, Handler>;
 docHandlers: Record<string, Handler>;
 document: { addEventListener: (t: string, fn: Handler) => void; hidden: boolean };
 timers: { id: number; fn: () => void; ms: number }[];
}

// Captures window/document event handlers and setTimeout callbacks so the
// test can fire them by hand. init() touches all three.
function stubWindowDocument(): StubbedGlobals {
 const stub: StubbedGlobals = {
  winHandlers: {},
  docHandlers: {},
  document: {
   addEventListener: (t: string, fn: Handler) => {
    stub.docHandlers[t] = fn;
   },
   hidden: false,
  },
  timers: [],
 };
 let nextId = 1;
 vi.stubGlobal("window", {
  addEventListener: (t: string, fn: Handler) => {
   stub.winHandlers[t] = fn;
  },
  setTimeout: (fn: () => void, ms: number) => {
   const id = nextId++;
   stub.timers.push({ id, fn, ms });
   return id;
  },
  clearTimeout: (id: number) => {
   stub.timers = stub.timers.filter((t) => t.id !== id);
  },
 });
 vi.stubGlobal("document", stub.document);
 return stub;
}

function makeTerrain() {
 return {
  heightAt: () => 0,
  heightfield: { minHeight: -10, maxHeight: 30, heightAt: () => 0 },
  deform: { brush: vi.fn() },
 } as unknown as Terrain & { deform: { brush: Mock } };
}

function makeGfx() {
 const addMesh = vi.fn();
 const sceneRemove = vi.fn();
 const gfx = {
  addMesh,
  scene: { remove: sceneRemove },
  threeCamera: new THREE.Camera(),
  LAYER: { OPAQUE: 1, BLEND: 2 },
 } as unknown as Gfx;
 return { gfx, addMesh, sceneRemove };
}

function makePeers() {
 const depthPass = {
  registerCaster: vi.fn(),
  removeCaster: vi.fn(),
 } as unknown as DepthPass & {
  registerCaster: Mock;
  removeCaster: Mock;
 };
 const shadows = {
  registerCaster: vi.fn(),
  unregisterCaster: vi.fn(),
 } as unknown as ShadowSystem & {
  registerCaster: Mock;
  unregisterCaster: Mock;
 };
 const sky = { sunDir: new THREE.Vector3(0, 1, 0) } as unknown as Sky;
 return { depthPass, shadows, sky };
}

function makeExcavation() {
 const { gfx, addMesh, sceneRemove } = makeGfx();
 const { depthPass, shadows, sky } = makePeers();
 const terrain = makeTerrain();
 const exc = new Excavation(gfx, terrain, depthPass, shadows, sky);
 return { exc, gfx, addMesh, sceneRemove, depthPass, shadows, terrain };
}

async function makeInited() {
 const stub = stubWindowDocument();
 const peers = makeExcavation();
 await peers.exc.init();
 return { stub, ...peers };
}

afterEach(() => {
 vi.unstubAllGlobals();
 vi.restoreAllMocks();
});

// ------------------------------------------------------- init() lifecycle

describe("excavation init", () => {
 it("drains the initial queue, meshes and registers casters", async () => {
  const { exc, addMesh, depthPass, shadows } = await makeInited();
  expect(exc._queue).toHaveLength(0);
  expect(exc._queued.size).toBe(0);
  expect(exc.meshes.size).toBeGreaterThan(0);
  expect(addMesh).toHaveBeenCalledTimes(exc.meshes.size);
  expect(depthPass.registerCaster).toHaveBeenCalledTimes(exc.meshes.size);
  expect(shadows.registerCaster).toHaveBeenCalledTimes(exc.meshes.size);
 }, 30_000);

 it("derives the chunk cy range from the heightfield bounds", async () => {
  const { exc } = await makeInited();
  // floor((-10 - 2) / 8) - 1 = -3, floor(30 / 8) + 1 = 4
  expect(exc._cyMin).toBe(-3);
  expect(exc._cyMax).toBe(4);
 }, 30_000);

 it("registers the pit-mask uniforms and paints the initial window", async () => {
  const { exc } = await makeInited();
  expect(pitMaskUniforms.maskTex.value).toBe(exc.pitMaskTex);
  expect(pitMaskUniforms.maskSize.value).toBe(PIT_MASK_WINDOW);
  expect(pitMaskUniforms.maskCenter.value.x).toBe(0);
  expect(pitMaskUniforms.maskCenter.value.y).toBe(0);
  expect(exc.pitMaskData).toHaveLength(PIT_MASK_RES * PIT_MASK_RES);
  expect(exc.pitMaskTex.name).toBe("pitMaskTex");
 }, 30_000);

 it("registers pagehide and visibilitychange persistence handlers", async () => {
  const { stub } = await makeInited();
  expect(typeof stub.winHandlers["pagehide"]).toBe("function");
  expect(typeof stub.docHandlers["visibilitychange"]).toBe("function");
 }, 30_000);
});

// ------------------------------------------------------- ensureChunksAround

describe("ensureChunksAround", () => {
 it("queues a symmetric chunk ring and dedupes repeat calls", () => {
  const { exc } = makeExcavation(); // no init: defaults cy -1..1, no window needed
  exc.ensureChunksAround(0, 0, 8); // rChunks = 1 -> 3x3 cells x 3 cy layers
  expect(exc._queue).toHaveLength(27);
  expect(exc._queued.size).toBe(27);
  for (let dx = -1; dx <= 1; dx++)
   for (let dz = -1; dz <= 1; dz++)
    for (let cy = -1; cy <= 1; cy++) expect(exc._queued.has(`${dx},${cy},${dz}`)).toBe(true);
  // Symmetric about the origin.
  for (const key of [...exc._queued]) {
   const [cx, cy, cz] = key.split(",").map(Number);
   expect(exc._queued.has(`${-cx},${cy},${-cz}`)).toBe(true);
  }
  // Second call adds nothing.
  exc.ensureChunksAround(0, 0, 8);
  expect(exc._queue).toHaveLength(27);
  expect(exc._queued.size).toBe(27);
 });

 it("skips chunks that already have meshes", () => {
  const { exc } = makeExcavation();
  exc.meshes.set("0,0,0", {} as THREE.Mesh);
  exc.ensureChunksAround(0, 0, 8);
  expect(exc._queued.has("0,0,0")).toBe(false);
  expect(exc._queue).toHaveLength(26);
 });
});

// ------------------------------------------------------------- update()

describe("update", () => {
 it("unloads far chunks without excavation and keeps exhumed ones", async () => {
  const { exc, depthPass, shadows, sceneRemove } = await makeInited();
  // Exhume two chunks by carving one bed voxel in each (bed row is iy=0).
  expect(exc.grid.setVoxel(0, 0, 0, MAT_EMPTY)).toBe(true);
  const w = worldToVoxel(-10.25, 0, 25.25);
  expect(w.ix).toBeLessThan(0); // sanity: negative chunk range
  expect(exc.grid.setVoxel(w.ix, 0, w.iz, MAT_EMPTY)).toBe(true);
  const exhumedA = "0,0,0";
  const ez = voxelChunkKey(w.ix, 0, w.iz);
  const intact = exc.meshes.get("1,0,0")!;
  expect(intact).toBeDefined();

  exc.update(new THREE.Vector3(200, 0, 0));

  expect(exc.meshes.has(exhumedA)).toBe(true); // exhumed: kept despite distance
  expect(exc.meshes.has(ez)).toBe(true); // exhumed: kept despite distance
  expect(exc.meshes.has("1,0,0")).toBe(false); // intact + far: unloaded
  expect(depthPass.removeCaster).toHaveBeenCalledWith(intact);
  expect(shadows.unregisterCaster).toHaveBeenCalledWith(intact);
  expect(sceneRemove).toHaveBeenCalledWith(intact);
 }, 30_000);

 it("update() queues chunks around the moved camera, not the origin (SUSPECTED SRC BUG — see report)", async () => {
  // ensureChunksAround(cx, cz, radius) never reads its cx/cz arguments:
  // `const wx = dx * 8` anchors the ring at the world origin, so after the
  // initial drain nothing around a moved camera is ever queued. This encodes
  // the intended contract — the load ring follows the camera.
  const { exc } = await makeInited();
  exc.update(new THREE.Vector3(200, 0, 0)); // camera cell cx = 25
  expect(exc._queue.some((e) => Math.abs(e.cx - 25) <= 12 && Math.abs(e.cz) <= 12)).toBe(true);
 }, 30_000);
});

function voxelChunkKey(ix: number, iy: number, iz: number): string {
 const c = (n: number) => Math.floor(n / 16);
 return `${c(ix)},${c(iy)},${c(iz)}`;
}

// --------------------------------------------------------- rebuildChunk()

describe("rebuildChunk", () => {
 it("replaces a stale mesh in place: disposes old geometry, no duplicate addMesh", async () => {
  const { exc, addMesh } = await makeInited();
  const key = "2,0,1";
  const oldMesh = exc.meshes.get(key)!;
  const oldGeometry = oldMesh.geometry;
  const disposeSpy = vi.spyOn(oldGeometry, "dispose");
  const addsBefore = addMesh.mock.calls.length;

  exc.grid.setVoxel(2 * 16, 0, 1 * 16, MAT_EMPTY); // carve: make it a carved column
  exc.rebuildChunk(2, 0, 1);

  expect(disposeSpy).toHaveBeenCalledTimes(1);
  expect(exc.meshes.get(key)).toBe(oldMesh); // same mesh object, swapped geometry
  expect(oldMesh.geometry).not.toBe(oldGeometry);
  expect(addMesh.mock.calls.length).toBe(addsBefore); // not re-added
 }, 30_000);

 it("adds a fresh mesh for a carved column whose mesh went missing", async () => {
  const { exc, addMesh } = await makeInited();
  const key = "2,0,1";
  exc.meshes.delete(key); // simulate a lost/stale mesh entry
  const addsBefore = addMesh.mock.calls.length;

  exc.grid.setVoxel(2 * 16, 0, 1 * 16, MAT_EMPTY);
  exc.rebuildChunk(2, 0, 1);

  expect(addMesh.mock.calls.length).toBe(addsBefore + 1);
  expect(exc.meshes.has(key)).toBe(true);
 }, 30_000);

 it("ignores chunks that were never ensured", async () => {
  const { exc, addMesh } = await makeInited();
  const addsBefore = addMesh.mock.calls.length;
  exc.rebuildChunk(63, 0, 63);
  expect(addMesh.mock.calls.length).toBe(addsBefore);
  expect(exc.meshes.has("63,0,63")).toBe(false);
 }, 30_000);

 it("keeps the reported triangle count consistent with the meshes", async () => {
  const { exc } = await makeInited();
  let expected = 0;
  for (const m of exc.meshes.values()) expected += (m.geometry.index?.count ?? 0) / 3;
  expect(exc.triangles).toBe(expected);
  expect(exc.triangles).toBeGreaterThan(0);
 }, 30_000);
});

// ------------------------------------------------------------ saveTimer

describe("scheduleSave debounce", () => {
 it("coalesces repeat calls into one timer and fires saveDirty once", () => {
  const stub = stubWindowDocument();
  const { exc } = makeExcavation();
  const saveSpy = vi.spyOn(exc.grid, "saveDirty").mockResolvedValue(undefined);

  exc.scheduleSave();
  expect(exc.saveTimer).not.toBeNull();
  exc.scheduleSave();
  exc.scheduleSave();
  expect(stub.timers).toHaveLength(1); // debounced
  expect(saveSpy).not.toHaveBeenCalled();

  stub.timers[0]!.fn(); // fire the 2 s debounce
  expect(exc.saveTimer).toBeNull();
  expect(saveSpy).toHaveBeenCalledTimes(1);

  exc.scheduleSave(); // re-arms after firing
  expect(stub.timers).toHaveLength(2);
 });
});

// --------------------------------------------- pagehide / visibilitychange

describe("persistence handlers", () => {
 it("pagehide and hidden-visibility both trigger grid.saveDirty", async () => {
  const { stub, exc } = await makeInited();
  const saveSpy = vi.spyOn(exc.grid, "saveDirty").mockResolvedValue(undefined);

  stub.winHandlers["pagehide"]!();
  expect(saveSpy).toHaveBeenCalledTimes(1);

  stub.document.hidden = true;
  stub.docHandlers["visibilitychange"]!();
  expect(saveSpy).toHaveBeenCalledTimes(2);

  stub.document.hidden = false;
  stub.docHandlers["visibilitychange"]!(); // page visible again: no save
  expect(saveSpy).toHaveBeenCalledTimes(2);
 }, 30_000);
});

