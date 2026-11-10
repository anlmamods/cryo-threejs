import { describe, it, expect, afterEach, vi } from "vitest";
import { createDeathMenu } from "../src/ui/deathMenu.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDeathMenu (no DOM)", () => {
  it("starts hidden; show() makes visible, hide() hides again", () => {
    const menu = createDeathMenu();
    expect(menu.isVisible()).toBe(false);
    menu.show("terrain", { flashes: 3, rad01: 0.5 });
    expect(menu.isVisible()).toBe(true);
    menu.hide();
    expect(menu.isVisible()).toBe(false);
  });

  it("show() is idempotent and hide() from hidden stays hidden", () => {
    const menu = createDeathMenu();
    menu.show("radiation", { flashes: 7, rad01: 1 });
    menu.show("radiation", { flashes: 7, rad01: 1 });
    expect(menu.isVisible()).toBe(true);
    menu.hide();
    menu.hide();
    expect(menu.isVisible()).toBe(false);
    menu.show("terrain", { flashes: 0, rad01: 0 });
    expect(menu.isVisible()).toBe(true);
  });

  it("onRedeploy registers a callback without throwing", () => {
    const menu = createDeathMenu();
    expect(() => menu.onRedeploy(() => { })).not.toThrow();
  });

  // fireRedeploy is only reachable through window keydown / button click; with
  // no DOM those paths do not exist. Stubbing window lets us observe the
  // registration end-to-end: Enter fires the callback only while visible.
  it("registered onRedeploy fires on Enter keydown only while visible", () => {
    const handlers: Array<(e: { code: string; repeat: boolean; preventDefault(): void }) => void> = [];
    vi.stubGlobal("window", {
      addEventListener: (name: string, fn: (typeof handlers)[number]) => {
        if (name === "keydown") handlers.push(fn);
      },
    });
    const menu = createDeathMenu();
    const cb = vi.fn();
    menu.onRedeploy(cb);
    const key = { code: "Enter", repeat: false, preventDefault: vi.fn() };

    menu.show("terrain", { flashes: 1, rad01: 0.25 });
    expect(handlers.length).toBe(1);
    handlers[0](key);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(key.preventDefault).toHaveBeenCalledTimes(1);

    menu.hide();
    handlers[0](key); // not visible -> ignored
    expect(cb).toHaveBeenCalledTimes(1);

    handlers[0]({ code: "KeyW", repeat: false, preventDefault: vi.fn() });
    menu.show("radiation", { flashes: 2, rad01: 0.75 });
    handlers[0]({ code: "Enter", repeat: true, preventDefault: vi.fn() }); // repeat -> ignored
    expect(cb).toHaveBeenCalledTimes(1);
    handlers[0]({ code: "Space", repeat: false, preventDefault: vi.fn() });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
