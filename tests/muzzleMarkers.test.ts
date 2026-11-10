import { describe, it, expect, beforeAll } from "vitest";
import * as THREE from "three";
import { MuzzleMarkers } from "../src/vfx/muzzleMarkers.js";
import { registerShaders } from "../src/shaders/registry.js";

const POOL = 32;

function makeGfx() {
  const added: Array<{ mesh: unknown; layer: unknown; order: unknown }> = [];
  const gfx = {
    addMesh(mesh: THREE.Mesh, layer: number, order: number) {
      added.push({ mesh, layer, order });
      return mesh;
    },
    LAYER: { SKY: 0, OPAQUE: 1, BLEND: 2 },
    scene: new THREE.Scene(),
  };
  return { gfx, added };
}

function makeMarkers() {
  const { gfx, added } = makeGfx();
  const markers = new MuzzleMarkers(gfx as never);
  return { markers, added };
}

beforeAll(() => {
  registerShaders();
});

describe("MuzzleMarkers construction", () => {
  it("registers the mesh on the blend layer and starts invisible with zero rings", () => {
    const { markers, added } = makeMarkers();
    expect(added.length).toBe(1);
    expect(added[0].layer).toBe(2);
    expect(added[0].order).toBe(60);
    expect(markers.mesh.visible).toBe(false);
    expect(markers._count).toBe(0);
    expect(markers.mesh.metadata.vertices).toBe(POOL * 4);
    expect(markers.mesh.metadata.triangles).toBe(POOL * 2);
  });
});

describe("MuzzleMarkers begin/add/commit cycle", () => {
  it("packs center/radius into row 0 and colour into row 1 of the data texture", () => {
    const { markers } = makeMarkers();
    markers.begin();
    markers.add(1, 2, 3, 0.25, 0.2, 0.4, 0.6);
    markers.commit();
    expect(markers._count).toBe(1);
    expect(markers._data[0]).toBe(1);
    expect(markers._data[1]).toBe(2);
    expect(markers._data[2]).toBe(3);
    expect(markers._data[3]).toBeCloseTo(0.25);
    const c = (POOL + 0) * 4;
    expect(markers._data[c]).toBeCloseTo(0.2);
    expect(markers._data[c + 1]).toBeCloseTo(0.4);
    expect(markers._data[c + 2]).toBeCloseTo(0.6);
    expect(markers._data[c + 3]).toBe(1);
    expect(markers.mesh.visible).toBe(true);
  });

  it("commit with zero adds hides the mesh and zeroes leftover radius rows", () => {
    const { markers } = makeMarkers();
    markers.begin();
    markers.add(5, 6, 7, 0.5, 1, 0, 0);
    markers.commit();
    expect(markers.mesh.visible).toBe(true);
    // Next frame: no shots fired, no rings re-added.
    markers.begin();
    markers.commit();
    expect(markers._count).toBe(0);
    expect(markers.mesh.visible).toBe(false);
    expect(markers._data[3]).toBe(0); // stale ring radius cleared
  });

  it("clears only slots beyond _count, keeping this frame's rings intact", () => {
    const { markers } = makeMarkers();
    markers.begin();
    markers.add(1, 1, 1, 0.5, 1, 1, 1);
    markers.add(2, 2, 2, 0.75, 1, 1, 1);
    markers.commit();
    markers.begin();
    markers.add(9, 9, 9, 0.125, 0, 1, 0);
    markers.commit(); // slot 1 must be zeroed, slot 0 kept
    expect(markers._data[0]).toBe(9);
    expect(markers._data[3]).toBeCloseTo(0.125);
    expect(markers._data[4 + 3]).toBe(0); // slot 1 radius cleared
    expect(markers.mesh.visible).toBe(true);
  });

  it("begin() resets the cursor so a fresh frame overwrites old rings", () => {
    const { markers } = makeMarkers();
    markers.begin();
    markers.add(1, 1, 1, 0.5, 1, 0, 0);
    markers.add(2, 2, 2, 0.5, 0, 1, 0);
    markers.begin();
    expect(markers._count).toBe(0);
    markers.add(3, 3, 3, 0.5, 0, 0, 1);
    markers.commit();
    expect(markers._data[0]).toBe(3); // overwritten in place
    expect(markers._data[4 + 3]).toBe(0); // old slot 1 cleared by commit
  });

  it("copies cameraPos into the shared uniform vector when provided", () => {
    const { markers } = makeMarkers();
    markers.commit(new THREE.Vector3(7, 8, 9));
    expect(markers._cameraPos.x).toBe(7);
    expect(markers._cameraPos.y).toBe(8);
    expect(markers._cameraPos.z).toBe(9);
    expect(markers.material.uniforms.cameraPos.value).toBe(markers._cameraPos);
  });
});

describe("MuzzleMarkers pool cap", () => {
  it("refuses rings beyond the 32-marker pool", () => {
    const { markers } = makeMarkers();
    markers.begin();
    for (let i = 0; i < POOL + 8; i++) markers.add(i, 0, 0, 0.1, 1, 1, 1);
    expect(markers._count).toBe(POOL);
    expect(markers._data[(POOL - 1) * 4]).toBe(POOL - 1); // last kept slot
  });

  it("still draws exactly POOL rings when overflowed, then drains clean next frame", () => {
    const { markers } = makeMarkers();
    markers.begin();
    for (let i = 0; i < POOL + 10; i++) markers.add(i, i, i, 0.2, 1, 0, 0);
    markers.commit();
    expect(markers.mesh.visible).toBe(true);
    // No slot carries a radius from the rejected adds.
    for (let i = 0; i < POOL; i++) {
      expect(markers._data[i * 4 + 3]).toBeCloseTo(0.2);
    }
    markers.begin();
    markers.commit();
    expect(markers.mesh.visible).toBe(false);
    for (let i = 0; i < POOL; i++) {
      expect(markers._data[i * 4 + 3]).toBe(0);
    }
  });
});

describe("MuzzleMarkers shot lifecycle", () => {
  it("rings appear on the shot frame and vanish on the following quiet frame", () => {
    const { markers } = makeMarkers();
    // Frame 1: two guns fire — two rings appear.
    markers.begin();
    markers.add(-0.3, 1.0, 2.0, 0.05, 1, 0.8, 0.2);
    markers.add(0.3, 1.0, 2.0, 0.05, 1, 0.8, 0.2);
    markers.commit(new THREE.Vector3(0, 1.6, 0));
    expect(markers.mesh.visible).toBe(true);
    expect(markers._count).toBe(2);
    // Frame 2: trigger released — markers reset.
    markers.begin();
    markers.commit();
    expect(markers.mesh.visible).toBe(false);
    expect(markers._count).toBe(0);
  });
});
