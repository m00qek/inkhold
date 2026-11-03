import { describe, it, expect } from "vitest";
import { bootFailureCause } from "../../src/pages/bootFailure";
import { ApiError } from "../../src/api/client";

describe("bootFailureCause", () => {
  it("names an unreachable server, and answers the question it raises", () => {
    const c = bootFailureCause(new ApiError("NETWORK", "Can't reach the server.", 0));
    expect(c.title).toBe("Can't reach the server");
    expect(c.detail).toContain("already loaded");
  });

  it("keeps a timeout distinct from an unreachable server", () => {
    const c = bootFailureCause(new ApiError("TIMEOUT", "The server is taking too long to answer.", 0));
    expect(c.title).not.toBe("Can't reach the server");
    expect(c.detail).toContain("connection went through");
  });

  it("repeats the client's own wording for an answer it could not use", () => {
    const c = bootFailureCause(new ApiError("SERVER", "The server returned an unexpected response.", 500));
    expect(c.detail).toBe("The server returned an unexpected response.");
  });

  it("never blames the user for a failure it cannot classify", () => {
    for (const e of [new Error("boom"), "boom", null, undefined]) {
      const c = bootFailureCause(e);
      expect(c.title).toBe("The app couldn't start");
      expect(c.detail).not.toMatch(/sorry|apolog/i);
    }
  });
});
