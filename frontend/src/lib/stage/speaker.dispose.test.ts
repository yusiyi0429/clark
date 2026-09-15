import { afterEach, describe, expect, it, vi } from "vitest";
import { Speaker } from "./speaker";

afterEach(() => { vi.unstubAllGlobals(); });

describe("Speaker lifecycle", () => {
  it("releases its audio context and gesture handlers on unmount", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    vi.stubGlobal("AudioContext", class {
      state = "running";
      destination = {};
      close = close;
      createGain() { return { connect: vi.fn(), disconnect }; }
    });
    const speaker = new Speaker();
    await speaker.unlock();
    speaker.dispose();
    speaker.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(removeEventListener).toHaveBeenCalledTimes(2);
  });
});
