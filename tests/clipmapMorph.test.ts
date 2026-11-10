import { describe, it, expect } from "vitest";
import { BASE_SPACING, GRID_HALF_N } from "../src/terrain/clipmapMesh.js";

describe("clipmap mesh constants", () => {
  it("BASE_SPACING", () => expect(BASE_SPACING).toBe(0.085));
  it("GRID_HALF_N", () => expect(GRID_HALF_N).toBe(80));
});
