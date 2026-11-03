import { describe, it, expect } from "vitest";
import { ApiError, RateLimitError } from "../../src/api/client";
import type { AdminDevice, AdminUser } from "../../src/api/adminTypes";

// --- fixtures ----------------------------------------------------------------
import { ANA, RUI, elevationRequired, server, build, shown } from "./admin.shared";

const flush = (): Promise<void> => new Promise((r) => void setTimeout(r, 0));

// --- the gate ----------------------------------------------------------------

describe("admin console: the gate", () => {
  it("starts locked and shows no household before the password is confirmed", () => {
    const t = build();
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    expect(t.api.adminListUsers).not.toHaveBeenCalled();
  });

  it("opening while un-elevated asks for the list, is refused, and returns to the gate", async () => {
    const t = build();
    await t.console.open();
    expect(t.api.adminListUsers).toHaveBeenCalledTimes(1);
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    expect(t.last()).toEqual({ kind: "locked", error: null, busy: false });
  });

  it("a wrong password keeps the gate up, says so, and never lists", async () => {
    const t = build();
    await t.console.unlock("nope");
    expect(t.console.state()).toEqual({
      kind: "locked",
      error: "That password doesn't match.",
      busy: false,
    });
    expect(t.api.adminListUsers).not.toHaveBeenCalled();
  });

  it("does not distinguish a wrong password from a caller who is not an admin", async () => {
    // Both are INVALID_CREDENTIALS by design, so the endpoint cannot enumerate admins.
    const t = build();
    t.api.adminElevate.mockRejectedValueOnce(new ApiError("INVALID_CREDENTIALS", "password incorrect", 200));
    await t.console.unlock("whatever");
    expect((t.console.state() as { error: string }).error).toBe("That password doesn't match.");
  });

  it("reports a rate limit as attempts, not as a bad password", async () => {
    const t = build();
    t.api.adminElevate.mockRejectedValueOnce(new RateLimitError(42));
    await t.console.unlock("correct");
    expect((t.console.state() as { error: string }).error).toBe("Too many attempts. Try again in 42s.");
  });

  it("a correct password elevates and lists the household", async () => {
    const t = build();
    await t.console.unlock("correct");
    expect(t.api.adminElevate).toHaveBeenCalledWith("ana@household.lan", "correct");
    expect(shown(t.console.state())).toEqual(["ana@household.lan", "rui@household.lan"]);
  });

  it("marks itself busy while the password is in flight, so it cannot be sent twice", async () => {
    const t = build();
    const inFlight = t.console.unlock("correct");
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: true });
    await t.console.unlock("correct");
    await inFlight;
    expect(t.api.adminElevate).toHaveBeenCalledTimes(1);
  });

  it("locking returns to the gate immediately, before the server has answered", async () => {
    const t = build();
    await t.console.unlock("correct");
    let release = (): void => {};
    t.api.adminLock.mockImplementationOnce(() => new Promise<void>((r) => void (release = r)));

    const locking = t.console.lock();
    expect(t.console.state()).toEqual({ kind: "locked", error: null, busy: false });
    release();
    await locking;
    expect(t.api.adminLock).toHaveBeenCalled();
  });

  it("routes a dead session to the shell, never to its own gate", async () => {
    const t = build();
    t.api.adminListUsers.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", "Your session has ended.", 401));
    await t.console.open();
    expect(t.onSessionExpired).toHaveBeenCalledTimes(1);
    // 401 is a dead session; 428 is a live one that needs re-confirming.
    expect(t.view.confirm).not.toHaveBeenCalled();
  });
});

// --- elevation, as seen from outside the console -----------------------------

describe("admin console: elevation, as the rail sees it", () => {
  it("is locked before anything has been asked, and stays locked through a refused open", async () => {
    const t = build();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).not.toHaveBeenCalled();

    await t.console.open();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).not.toHaveBeenCalled();
  });

  it("does not read as elevated merely because the console is mid-load", async () => {
    // `open()` paints `loading` before the server answers; that is not elevation.
    const t = build();
    const opening = t.console.open();
    expect(t.console.state().kind).toBe("loading");
    expect(t.console.isElevated()).toBe(false);
    await opening;
  });

  it("opens on a successful unlock and announces it exactly once", async () => {
    const t = build();
    await t.console.unlock("correct");
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("closes on lock, and announces that too", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();
    await t.console.lock();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("closes when the window lapses under the admin and the gate goes back up", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();

    t.state.elevated = false;
    const deleting = t.console.deletePerson(RUI);
    await flush();
    expect(t.console.state().kind).toBe("locked");
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);

    await t.console.unlock("correct");
    await deleting;
    expect(t.console.isElevated()).toBe(true);
  });

  it("closes when the session itself dies — elevation cannot outlive it", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();

    t.api.adminListUsers.mockRejectedValueOnce(new ApiError("UNAUTHORIZED", "Your session has ended.", 401));
    await t.console.open();
    expect(t.console.isElevated()).toBe(false);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });

  it("says nothing on a refresh that did not change hands", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.onElevationChanged.mockClear();
    await t.console.open();
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).not.toHaveBeenCalled();
  });

  it("opens without an unlock when the session was ALREADY elevated", async () => {
    const t = build();
    t.state.elevated = true;
    await t.console.open();
    expect(t.console.isElevated()).toBe(true);
    expect(t.onElevationChanged).toHaveBeenCalledTimes(1);
  });
});

// --- the elevate-and-retry loop ----------------------------------------------

describe("admin console: elevate and retry", () => {
  it("resumes the call that hit the gate, rather than making the admin re-click it", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const deleting = t.console.deletePerson(RUI);
    await flush();
    expect(t.console.state().kind).toBe("locked");

    await t.console.unlock("correct");
    await deleting;

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.api.adminDeleteUser).toHaveBeenCalledWith(RUI.id);
    expect(shown(t.console.state())).toEqual(["ana@household.lan"]);
    expect(t.view.confirm).toHaveBeenCalledTimes(1);
  });

  it("retries exactly once — a second refusal is not retried again", async () => {
    const t = build();
    await t.console.unlock("correct");
    // The server keeps refusing after a successful elevate (clock skew, revoked session).
    t.api.adminDeleteUser.mockRejectedValue(elevationRequired());

    const deleting = t.console.deletePerson(RUI);
    await flush();
    await t.console.unlock("correct");
    await deleting;

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.console.state().kind).toBe("locked");
  });

  it("a gate that is locked instead of satisfied abandons the call, changing nothing", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const deleting = t.console.deletePerson(RUI);
    await flush();
    await t.console.lock();

    await deleting;
    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(1);
    expect(t.console.state().kind).toBe("locked");
  });

  it("parks several refused calls on one gate and releases them all", async () => {
    const t = build();
    await t.console.unlock("correct");
    t.state.elevated = false;

    const a = t.console.deletePerson(RUI);
    const b = t.console.resetPassword(ANA);
    await flush();
    await t.console.unlock("correct");
    await Promise.all([a, b]);

    expect(t.api.adminDeleteUser).toHaveBeenCalledTimes(2);
    expect(t.api.adminResetPassword).toHaveBeenCalledTimes(2);
    expect(t.console.state().kind).toBe("ready");
  });

  it("opening the console does not park on the gate, so walking away leaks nothing", async () => {
    const t = build();
    await t.console.open();
    expect(t.console.state().kind).toBe("locked");
    expect(t.api.adminListUsers).toHaveBeenCalledTimes(1);
  });
});

// --- the actions -------------------------------------------------------------
