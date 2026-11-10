/**
 * core/input.ts — raw input state machine.
 *
 * The module owns module-level state (`keys`, `rmbHeld`, `touchSeen`), so each
 * test rebuilds the DOM stubs and re-calls `initInput`, then resets the
 * exported `input`/`touch` fields by hand. `keys` is cleared by dispatching
 * the captured `blur` handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { input, touch, initInput, pollInput, endFrame, isDown } from "../src/core/input.js";
import { S } from "../src/core/settings.js";

interface FakeEvent {
 code?: string;
 repeat?: boolean;
 button?: number;
 deltaY?: number;
 movementX?: number;
 movementY?: number;
 pointerType?: string;
 preventDefault?: () => void;
}
type Handler = (e: FakeEvent) => void;

interface Stubbed {
 canvas: { addEventListener: (t: string, fn: Handler) => void; requestPointerLock: Mock };
 canvasHandlers: Record<string, Handler>;
 docHandlers: Record<string, Handler>;
 winHandlers: Record<string, Handler>;
 document: { addEventListener: (t: string, fn: Handler) => void; pointerLockElement: unknown };
}

function stubDom(): Stubbed {
 const stub = {} as Stubbed;
 stub.canvasHandlers = {};
 stub.docHandlers = {};
 stub.winHandlers = {};
 stub.canvas = {
  addEventListener: (t, fn) => { stub.canvasHandlers[t] = fn; },
  requestPointerLock: vi.fn(),
 };
 stub.document = {
  addEventListener: (t, fn) => { stub.docHandlers[t] = fn; },
  pointerLockElement: null,
 };
 vi.stubGlobal("window", {
  addEventListener: (t: string, fn: Handler) => { stub.winHandlers[t] = fn; },
 });
 vi.stubGlobal("document", stub.document);
 return stub;
}

function resetState(s: Stubbed) {
 // Clear module-level `keys` via the blur path.
 s.winHandlers["blur"]?.({});
 input.moveX = 0; input.moveZ = 0; input.moving = false;
 input.lookX = 0; input.lookY = 0; input.zoomDelta = 0;
 input.flying = false; input.surf = false; input.fire = false; input.sprint = false;
 input.riseLevel = 1; input.thrust = false; input.boost = false; input.vert = 0;
 input.spellPressed = 0; input.spellHeld2 = false; input.locked = false;
 touch.present = false; touch.x = 0; touch.z = 0;
 touch.active = false; touch.sprint = false; touch.surf = false;
 S.flightThrottle = false;
}

let dom: Stubbed;
beforeEach(() => {
 dom = stubDom();
 initInput(dom.canvas as unknown as HTMLElement);
 resetState(dom);
});
afterEach(() => {
 vi.unstubAllGlobals();
 S.flightThrottle = false;
});

const keydown = (code: string, repeat = false) => dom.winHandlers["keydown"]({ code, repeat, preventDefault: vi.fn() });
const keyup = (code: string) => dom.winHandlers["keyup"]({ code });

describe("pollInput movement axes", () => {
 it("clamps W+D diagonal to a unit disc", () => {
  keydown("KeyW"); keydown("KeyD");
  pollInput();
  expect(Math.hypot(input.moveX, input.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
  expect(input.moveX).toBeCloseTo(Math.SQRT1_2, 6);
  expect(input.moveZ).toBeCloseTo(Math.SQRT1_2, 6);
  expect(input.moving).toBe(true);
 });

 it("pure W is full deflection, no clamp needed", () => {
  keydown("KeyW");
  pollInput();
  expect(input.moveZ).toBe(1);
  expect(input.moveX).toBe(0);
  expect(input.moving).toBe(true);
 });

 it("no keys → not moving", () => {
  pollInput();
  expect(input.moving).toBe(false);
 });

 it("arrow keys work as aliases", () => {
  keydown("ArrowUp"); keydown("ArrowRight");
  pollInput();
  expect(Math.hypot(input.moveX, input.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
 });
});

describe("sprint", () => {
 it("ShiftLeft held → sprint", () => {
  keydown("ShiftLeft");
  pollInput();
  expect(input.sprint).toBe(true);
 });
 it("touch.sprint → sprint", () => {
  touch.sprint = true;
  pollInput();
  expect(input.sprint).toBe(true);
 });
 it("no shift, no touch → no sprint", () => {
  pollInput();
  expect(input.sprint).toBe(false);
 });
});

describe("surf / fire split", () => {
 it("flying pins surf=true and routes held trigger to fire", () => {
  input.flying = true;
  keydown("Space");
  pollInput();
  expect(input.surf).toBe(true);
  expect(input.fire).toBe(true);
 });
 it("flying with nothing held: surf still pinned, fire false", () => {
  input.flying = true;
  pollInput();
  expect(input.surf).toBe(true);
  expect(input.fire).toBe(false);
 });
 it("on foot: surf follows held space, fire stays false", () => {
  keydown("Space");
  pollInput();
  expect(input.surf).toBe(true);
  expect(input.fire).toBe(false);
 });
 it("on foot: surf follows touch.surf", () => {
  touch.surf = true;
  pollInput();
  expect(input.surf).toBe(true);
 });
 it("on foot: surf false when nothing held", () => {
  pollInput();
  expect(input.surf).toBe(false);
 });
 it("on foot: right mouse held sets surf; releasing one binding keeps the other", () => {
  // Lock pointer so mousedown registers.
  dom.document.pointerLockElement = dom.canvas;
  dom.docHandlers["pointerlockchange"]({});
  expect(input.locked).toBe(true);
  dom.docHandlers["mousedown"]({ button: 2 });
  keydown("Space");
  pollInput();
  expect(input.surf).toBe(true);
  dom.docHandlers["mouseup"]({ button: 2 });
  pollInput();
  expect(input.surf).toBe(true); // Space still held
  keyup("Space");
  pollInput();
  expect(input.surf).toBe(false);
 });
});

describe("throttle flight scheme (S.flightThrottle === true)", () => {
 beforeEach(() => { S.flightThrottle = true; input.flying = true; });

 it("W/S drive vert (W dives -1, S climbs +1)", () => {
  keydown("KeyW");
  pollInput();
  expect(input.vert).toBe(-1);
  keyup("KeyW"); keydown("KeyS");
  pollInput();
  expect(input.vert).toBe(1);
 });
 it("neither W nor S → vert 0", () => {
  pollInput();
  expect(input.vert).toBe(0);
 });
 it("boost on E", () => {
  keydown("KeyE");
  pollInput();
  expect(input.boost).toBe(true);
 });
 it("boost on Q", () => {
  keydown("KeyQ");
  pollInput();
  expect(input.boost).toBe(true);
 });
 it("no boost without E/Q", () => {
  pollInput();
  expect(input.boost).toBe(false);
 });
 it("thrust on Shift", () => {
  keydown("ShiftLeft");
  pollInput();
  expect(input.thrust).toBe(true);
 });
 it("disc clamp DISABLED on steer: W+D keeps both axes at full deflection", () => {
  keydown("KeyW"); keydown("KeyD");
  pollInput();
  expect(input.moveX).toBe(1);
  expect(input.moveZ).toBe(1);
  expect(Math.hypot(input.moveX, input.moveZ)).toBeGreaterThan(1);
 });
 it("throttle axes dead when flying is false", () => {
  input.flying = false;
  keydown("KeyE"); keydown("ShiftLeft"); keydown("KeyS");
  pollInput();
  expect(input.thrust).toBe(false);
  expect(input.boost).toBe(false);
  expect(input.vert).toBe(0);
 });
});

describe("riseLevel ladder (classic scheme)", () => {
 it("KeyE steps riseLevel and wraps 3 → 1; repeats ignored", () => {
  expect(input.riseLevel).toBe(1);
  keydown("KeyE");
  expect(input.riseLevel).toBe(2);
  keydown("KeyE", true); // repeat — ignored
  expect(input.riseLevel).toBe(2);
  keydown("KeyE");
  expect(input.riseLevel).toBe(3);
  keydown("KeyE");
  expect(input.riseLevel).toBe(1);
 });
 it("KeyE does NOT step riseLevel under the throttle scheme", () => {
  S.flightThrottle = true;
  keydown("KeyE");
  expect(input.riseLevel).toBe(1);
 });
});

describe("touch stick override", () => {
 it("touch.active forces stick axes over held keys", () => {
  keydown("KeyW"); // would be moveZ=1
  touch.active = true; touch.x = 0.25; touch.z = -0.5;
  pollInput();
  expect(input.moveX).toBe(0.25);
  expect(input.moveZ).toBe(-0.5);
  expect(input.moving).toBe(true);
 });
 it("touch.active with zero deflection forces moving=false even with keys held", () => {
  keydown("KeyW");
  touch.active = true; touch.x = 0; touch.z = 0;
  pollInput();
  expect(input.moving).toBe(false);
 });
 it("throttle scheme: stick vertical axis drives vert", () => {
  S.flightThrottle = true; input.flying = true;
  touch.active = true; touch.z = 0.75;
  pollInput();
  expect(input.vert).toBe(0.75);
 });
});

describe("isDown", () => {
 it("reflects held keys, false after keyup", () => {
  expect(isDown("KeyW")).toBe(false);
  keydown("KeyW");
  expect(isDown("KeyW")).toBe(true);
  keyup("KeyW");
  expect(isDown("KeyW")).toBe(false);
 });
});

describe("endFrame", () => {
 it("clears look/zoom/spellPressed", () => {
  input.lookX = 1.5; input.lookY = -2; input.zoomDelta = 0.3; input.spellPressed = 3;
  endFrame();
  expect(input.lookX).toBe(0);
  expect(input.lookY).toBe(0);
  expect(input.zoomDelta).toBe(0);
  expect(input.spellPressed).toBe(0);
 });
});

describe("spellPressed / spellHeld2", () => {
 it("digit keydown sets spellPressed and Digit2 sets spellHeld2", () => {
  keydown("Digit3");
  expect(input.spellPressed).toBe(3);
  keydown("Digit2");
  expect(input.spellPressed).toBe(2);
  expect(input.spellHeld2).toBe(true);
 });
 it("keyup Digit2 clears spellHeld2", () => {
  keydown("Digit2");
  keyup("Digit2");
  expect(input.spellHeld2).toBe(false);
 });
 it("digit keydown sets spellPressed even when pointer is NOT locked (current code path — see report)", () => {
  // Code review: the keydown handler sets spellPressed with no `input.locked`
  // gate, unlike mousemove/wheel/mousedown. Pinning observed behavior.
  expect(input.locked).toBe(false);
  keydown("Digit1");
  expect(input.spellPressed).toBe(1);
 });
 it("non-digit keys do not touch spellPressed", () => {
  keydown("KeyW");
  expect(input.spellPressed).toBe(0);
 });
});

describe("blur", () => {
 it("clears held keys, rmb, surf, spellHeld2 and touch state", () => {
  keydown("KeyW");
  touch.active = true; touch.x = 0.5; touch.z = 0.5; touch.sprint = true; touch.surf = true;
  input.spellHeld2 = true;
  dom.winHandlers["blur"]({});
  expect(isDown("KeyW")).toBe(false);
  expect(touch.active).toBe(false);
  expect(touch.x).toBe(0);
  expect(touch.z).toBe(0);
  expect(touch.sprint).toBe(false);
  expect(touch.surf).toBe(false);
  expect(input.surf).toBe(false);
  expect(input.spellHeld2).toBe(false);
 });
});

describe("pointer lock", () => {
 it("pointerlockchange to canvas sets locked=true; exit clears locked and held state", () => {
  keydown("KeyW");
  dom.document.pointerLockElement = dom.canvas;
  dom.docHandlers["pointerlockchange"]({});
  expect(input.locked).toBe(true);
  expect(isDown("KeyW")).toBe(true);
  dom.document.pointerLockElement = null;
  dom.docHandlers["pointerlockchange"]({});
  expect(input.locked).toBe(false);
  expect(isDown("KeyW")).toBe(false);
 });
 it("mousemove only accumulates look when locked", () => {
  dom.docHandlers["mousemove"]({ movementX: 100, movementY: 50 });
  expect(input.lookX).toBe(0);
  dom.document.pointerLockElement = dom.canvas;
  dom.docHandlers["pointerlockchange"]({});
  dom.docHandlers["mousemove"]({ movementX: 100, movementY: 50 });
  expect(input.lookX).toBeCloseTo(100 * 0.0022, 9);
  expect(input.lookY).toBeCloseTo(50 * 0.0022, 9);
 });
 it("wheel only zooms when locked, and preventDefaults", () => {
  const preventDefault = vi.fn();
  dom.docHandlers["wheel"]({ deltaY: 100, preventDefault });
  expect(input.zoomDelta).toBe(0);
  expect(preventDefault).not.toHaveBeenCalled();
  dom.document.pointerLockElement = dom.canvas;
  dom.docHandlers["pointerlockchange"]({});
  dom.docHandlers["wheel"]({ deltaY: 100, preventDefault });
  expect(input.zoomDelta).toBeCloseTo(100 * 0.0016, 9);
  expect(preventDefault).toHaveBeenCalledOnce();
 });
 it("right mouse only registers when locked", () => {
  dom.docHandlers["mousedown"]({ button: 2 });
  pollInput();
  expect(input.surf).toBe(false);
  dom.document.pointerLockElement = dom.canvas;
  dom.docHandlers["pointerlockchange"]({});
  dom.docHandlers["mousedown"]({ button: 2 });
  pollInput();
  expect(input.surf).toBe(true);
 });
 it("click requests pointer lock when not locked and no touch seen", () => {
  dom.canvasHandlers["click"]({});
  expect(dom.canvas.requestPointerLock).toHaveBeenCalledOnce();
 });
 it("click does not request pointer lock after a touch pointerdown", () => {
  dom.canvasHandlers["pointerdown"]({ pointerType: "touch" });
  dom.canvasHandlers["click"]({});
  expect(dom.canvas.requestPointerLock).not.toHaveBeenCalled();
 });
 it("contextmenu preventDefault is called", () => {
  const preventDefault = vi.fn();
  dom.canvasHandlers["contextmenu"]({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
 });
});

describe("UI toggle hooks", () => {
 it("F1 / Backquote call onToggleOverlay even when unlocked; KeyF calls onToggleFps", () => {
  const onToggleOverlay = vi.fn();
  const onToggleFps = vi.fn();
  const s = stubDom();
  initInput(s.canvas as unknown as HTMLElement, { onToggleOverlay, onToggleFps });
  s.winHandlers["keydown"]({ code: "F1", repeat: false, preventDefault: vi.fn() });
  s.winHandlers["keydown"]({ code: "Backquote", repeat: false, preventDefault: vi.fn() });
  expect(onToggleOverlay).toHaveBeenCalledTimes(2);
  s.winHandlers["keydown"]({ code: "KeyF", repeat: false, preventDefault: vi.fn() });
  expect(onToggleFps).toHaveBeenCalledTimes(1);
  s.winHandlers["keydown"]({ code: "KeyF", repeat: true, preventDefault: vi.fn() });
  expect(onToggleFps).toHaveBeenCalledTimes(1); // repeat ignored
 });
});

describe("exported structs exist and are mutable", () => {
 it("input/touch shapes", () => {
  expect(typeof input.moveX).toBe("number");
  expect(typeof input.flying).toBe("boolean");
  expect(typeof touch.present).toBe("boolean");
  expect(typeof isDown("KeyA")).toBe("boolean");
 });
});
