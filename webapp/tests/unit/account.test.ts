import { describe, it, expect } from "vitest";
import {
  deviceSeenLabel,
  discardNotice,
  failureMessage,
  otherSessionsLabel,
  passwordAgeLabel,
  passwordChangeConsequence,
  passwordFailureMessage,
  storageRows,
  thisBrowserLabel,
  versionsToDiscard,
} from "../../src/pages/account";
import { ApiError, RateLimitError } from "../../src/api/client";
import type { MyDevice } from "../../src/api/accountTypes";

// The account page's decisions, with no DOM — the same split `admin.ts` and
// `rail.ts` use. Two of these are load-bearing enough to be worth pinning on
// their own:
//
//   * THE DISCARD COUNT. It is stated BEFORE the change, and discarded versions
//     are gone — the recycle bin does not hold them. So a number that is wrong
//     by one is a promise the interface breaks irreversibly.
//   * PER FILE, NOT A POOL. `Σ max(0, count − keep)` and `max(0, Σcount − keep)`
//     agree on a one-file fixture and disagree on every real one, so the fixture
//     below has several files on purpose.

describe("versionsToDiscard", () => {
  it("counts per FILE, not against a shared pool", () => {
    // Six files, 25 retained versions between them. A pool reading would say
    // "25 − 3 = 22"; the per-file reading is 2+2+2+2+0+0.
    expect(versionsToDiscard([5, 5, 5, 5, 3, 2], 3)).toBe(8);
  });

  it("keeping what is already kept discards nothing", () => {
    expect(versionsToDiscard([5, 5, 5, 5, 3, 2], 5)).toBe(0);
  });

  it("raising the number discards nothing rather than reporting a negative", () => {
    expect(versionsToDiscard([5, 3, 1], 9)).toBe(0);
  });

  it("zero discards every retained version", () => {
    expect(versionsToDiscard([5, 5, 5, 5, 3, 2], 0)).toBe(25);
  });

  it("has nothing to discard when nothing is retained", () => {
    expect(versionsToDiscard([], 0)).toBe(0);
  });

  it("treats a half-typed / unparseable value as no change", () => {
    expect(versionsToDiscard([5, 5], Number.NaN)).toBe(0);
  });
});

describe("discardNotice", () => {
  it("states the fact before the change, with the count and the number chosen", () => {
    expect(discardNotice([5, 5, 5, 5, 3, 2], 3)).toBe("Keeping 3 will remove 8 versions now.");
  });

  it("says nothing when nothing would go — the line is not furniture", () => {
    expect(discardNotice([5, 5, 5, 5, 3, 2], 5)).toBeNull();
    expect(discardNotice([5, 3, 1], 9)).toBeNull();
  });

  it("singularises one version", () => {
    expect(discardNotice([2], 1)).toBe("Keeping 1 will remove 1 version now.");
  });

  it("treats zero as a real setting and says what it means going forward", () => {
    expect(discardNotice([5, 5], 0)).toBe("Keeping 0 will remove 10 versions now. No new versions will be kept.");
    // Zero with nothing retained is still a statement, not silence: choosing it
    // is a decision about the future, not only about what is on disk now.
    expect(discardNotice([], 0)).toBe("Nothing to discard, and no new versions will be kept.");
  });
});

describe("storageRows", () => {
  const byKind = { notebookBytes: 5, sketchBytes: 4, documentBytes: 3, binBytes: 2, versionBytes: 1 };

  it("splits into FIVE kinds, in the order the design sets out", () => {
    // Five, not four. The bin line was missing from the first draft and the live
    // database found it: three live kinds that summed short of `used_bytes` by
    // exactly two trashed files, leaving hundreds of MB unexplained on screen.
    expect(storageRows(byKind).map((r) => r.label)).toEqual([
      "Notebooks",
      "Sketches",
      "Documents",
      "Recycle bin",
      "Versions",
    ]);
  });

  it("keeps each figure with its own kind, and invents no totals of its own", () => {
    // The five are a PARTITION the SERVER computes; a client that re-derived or
    // reconciled one of them would be a second opinion about the meter.
    expect(storageRows(byKind).map((r) => r.bytes)).toEqual([5, 4, 3, 2, 1]);
  });

  it("names the extension where the device's own vocabulary is the clearer one", () => {
    const rows = storageRows(byKind);
    expect(rows[0]!.hint).toBe(".note");
    expect(rows[1]!.hint).toBe(".spd");
    // Images fold into Documents for now (§7's open question), and the hint has
    // to say so or the line reads as "text files only".
    expect(rows[2]!.hint).toContain("images");
  });

  it("says what the bin figure MEANS — what emptying it returns", () => {
    // The line counts the versions of trashed files too, because history is
    // purged with the file. A line promising 600 KB that frees 900 KB would be
    // wrong in the user's favour, which is still wrong — so the hint names the
    // remedy rather than describing the contents.
    const bin = storageRows(byKind).find((r) => r.key === "bin")!;
    expect(bin.hint).toContain("emptying");
  });
});

describe("the Signing in copy", () => {
  const now = Date.UTC(2026, 6, 30, 12, 0, 0);

  it("dates the password change relative to now", () => {
    expect(passwordAgeLabel(now / 1000 - 3 * 86_400, now)).toBe("Last changed 3 days ago");
  });

  it("blames the RECORD, not the person, when there is no date", () => {
    // `users.password_changed_at` does not exist yet and only becomes true from
    // the day it lands, so every existing account is unrecorded until its owner
    // next changes one. "Never changed" would be a claim about their habits made
    // from a column that was not there.
    expect(passwordAgeLabel(null, now)).toBe("No change recorded yet");
    expect(passwordAgeLabel(0, now)).toBe("No change recorded yet");
  });

  describe("what a password change costs", () => {
    const dev = (name: string, equipmentNo = "SN1") => ({
      equipmentNo,
      name,
      model: null,
      firmware: null,
      lastSeenAt: null,
      linkedAt: 0,
    });

    it("NAMES the device, because that is the object you have to go and find", () => {
      // The tablet is the part that matters and the line used to omit it: its
      // session dies with the browsers', but unlike a browser it cannot sign
      // itself back in — it authenticates with the password it has stored. So
      // sync stops until somebody walks over to it (user-options.md §9.1).
      const text = passwordChangeConsequence([dev("Supernote Nomad")]);
      expect(text).toContain("Supernote Nomad will stop syncing");
      expect(text).toContain("enter the new password on the device");
      expect(text).toContain("this one stays signed in");
    });

    it("falls back to the serial when the device never reported a name", () => {
      expect(passwordChangeConsequence([dev("", "SN078C10008618")])).toContain(
        "SN078C10008618 will stop syncing",
      );
    });

    it("says nothing about devices when none are bound", () => {
      // A standing warning about hardware you do not own is noise, and noise is
      // what teaches people to skip the line that matters.
      const text = passwordChangeConsequence([]);
      expect(text).toBe("Your other browsers will be signed out. This one stays signed in.");
      expect(text).not.toContain("sync");
    });

    it("counts them rather than listing them when there are several", () => {
      const text = passwordChangeConsequence([dev("Nomad", "SN1"), dev("Manta", "SN2")]);
      expect(text).toContain("Your 2 devices will stop syncing");
      expect(text).toContain("on each");
    });
  });

  it("dates THIS browser's session, and degrades to the plain statement", () => {
    expect(thisBrowserLabel(now / 1000 - 3 * 86_400, now)).toBe("Signed in here since 3 days ago");
    expect(thisBrowserLabel(null, now)).toBe("Signed in here");
  });

  it("counts OTHER browsers, so the honest answer for a lone session is zero", () => {
    expect(otherSessionsLabel(0)).toBe("No other browsers are signed in");
    expect(otherSessionsLabel(1)).toBe("1 other browser signed in");
    expect(otherSessionsLabel(2)).toBe("2 other browsers signed in");
  });
});

describe("deviceSeenLabel", () => {
  const now = Date.UTC(2026, 6, 30, 12, 0, 0);
  const nomad: MyDevice = {
    equipmentNo: "SN1000A2X",
    name: "Nomad",
    model: "A5X2",
    firmware: "3.20.29",
    lastSeenAt: now / 1000 - 20 * 60,
    linkedAt: now / 1000 - 190 * 86_400,
  };

  it("says SEEN, not SYNCED — the server records the last request, not the last sync", () => {
    // Decided against the data rather than the wish: the wider word would be
    // right almost always and wrong occasionally.
    expect(deviceSeenLabel(nomad, now)).toBe("last seen 20 minutes ago");
    expect(deviceSeenLabel(nomad, now)).not.toContain("sync");
  });

  it("distinguishes 'has not been seen' from an old date", () => {
    expect(deviceSeenLabel({ ...nomad, lastSeenAt: null }, now)).toBe("not seen since it was linked");
  });
});

describe("failure copy", () => {
  it("passes an ApiError's own words through, so a missing endpoint names itself", () => {
    const missing = new ApiError("NOT_IMPLEMENTED GET /api/controlplane/devices", "This server can't show your linked devices yet.", 501);
    expect(failureMessage(missing)).toBe("This server can't show your linked devices yet.");
  });

  it("phrases a rate limit as a wait rather than a failure", () => {
    expect(failureMessage(new RateLimitError(30))).toContain("Wait a moment");
  });

  it("falls back for anything that is not an ApiError at all", () => {
    expect(failureMessage(new TypeError("boom"))).toBe("Something went wrong. Try again.");
  });

  it("names the WRONG CURRENT PASSWORD as exactly that", () => {
    // The one refusal this form exists to be able to show. A generic "something
    // went wrong" here would leave a person re-typing a new password that was
    // never the problem.
    const wrong = new ApiError("INVALID_CREDENTIALS", "current password incorrect", 200);
    expect(passwordFailureMessage(wrong)).toBe("That isn't your current password.");
  });

  it("distinguishes 'that is already your password' from a wrong one", () => {
    const same = new ApiError("SAME_PASSWORD", "that is already your password", 200);
    expect(passwordFailureMessage(same)).toBe("Choose a password different from your current one.");
  });
});
