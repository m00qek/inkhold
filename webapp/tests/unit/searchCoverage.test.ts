// @vitest-environment happy-dom
// How much handwriting search can find, and what it says about the rest.

import { describe, it, expect } from "vitest";
import { coverageText, createSearchCoverage, summarize, why } from "../../src/pages/searchCoverage";
import type { NoteCoverage } from "../../src/api/types";

const n = (id: string, written: number, recognized: number, recognition = true, running = 0): NoteCoverage => ({ id, recognition, written, recognized, running });

describe("the numbers", () => {
  it("counts written pages, recognized ones, and the notes needing attention, worst first", () => {
    const s = summarize([n("1", 4, 4), n("2", 22, 0, false), n("3", 20, 2)]);
    expect(s).toMatchObject({ written: 46, recognized: 6 });
    expect(s.attention.map((x) => x.id)).toEqual(["2", "3"]);
  });

  it("says it plainly", () => {
    expect(coverageText(summarize([n("1", 4, 1)]))).toBe("Text is searchable on 1 of 4 pages with writing.");
    expect(coverageText(summarize([n("1", 4, 4)]))).toBe("All your handwriting is searchable: 4 pages.");
    expect(coverageText(summarize([]))).toBe("No handwriting to search yet.");
  });

  it("says why, per note", () => {
    expect(why(n("1", 22, 0, false))).toBe("Recognition is off on the tablet: 22 pages with writing can't be searched");
    // A page with typed text is searchable even with recognition off.
    expect(why(n("1", 22, 1, false))).toBe("Recognition is off on the tablet: 21 of 22 pages with writing can't be searched");
    expect(why(n("1", 20, 2))).toBe("18 of 20 pages with writing not recognized");
    expect(why(n("1", 5, 2, true, 3))).toBe("3 pages still being recognized on the tablet");
    expect(why(n("1", 6, 2, true, 1))).toBe("3 of 6 pages with writing not recognized; 1 page still being recognized on the tablet");
  });
});

describe("the block", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("asks once, repaints when the answer lands, and lists the notes it can name", async () => {
    let asked = 0;
    let painted = 0;
    const cov = createSearchCoverage({ searchCoverage: async () => (asked++, [n("1", 22, 0, false), n("2", 3, 1), n("9", 2, 0)]) }, () => painted++);
    expect(cov.block(() => null)).toBeNull();
    await settle();
    expect(painted).toBe(1);
    const box = cov.block((id) => ({ "1": "Diário", "2": "Aula" })[id] ?? null)!;
    expect(box.querySelector(".coverage__line")?.textContent).toBe("Text is searchable on 1 of 27 pages with writing.");
    // "9" is not in the listing: left out of the list, still counted.
    expect([...box.querySelectorAll(".coverage__name")].map((a) => a.textContent)).toEqual(["Diário", "Aula"]);
    cov.block(() => null);
    expect(asked).toBe(1);
  });

  // Regression: the open state was kept from the `toggle` event, which lands a task
  // after the click; a repaint in between rebuilt the list closed.
  it("stays open across a repaint that lands right after the click", async () => {
    const cov = createSearchCoverage({ searchCoverage: async () => [n("1", 22, 0, false)] }, () => {});
    cov.block(() => null);
    await settle();
    const first = cov.block(() => "Diário") as HTMLDetailsElement;
    first.open = true; // the click; its toggle event has not been delivered yet
    const again = cov.block(() => "Diário") as HTMLDetailsElement;
    expect(again.open).toBe(true);
    again.open = false;
    expect((cov.block(() => "Diário") as HTMLDetailsElement).open).toBe(false);
  });

  it("no list when everything is searchable", async () => {
    const cov = createSearchCoverage({ searchCoverage: async () => [n("1", 3, 3)] }, () => {});
    cov.block(() => null);
    await settle();
    const box = cov.block(() => "x")!;
    expect(box.tagName).toBe("P");
    expect(box.querySelector(".coverage__list")).toBeNull();
  });

  it("a failure says nothing, and leaves search alone", async () => {
    const cov = createSearchCoverage({ searchCoverage: async () => { throw new Error("offline"); } }, () => {});
    cov.block(() => null);
    await settle();
    expect(cov.block(() => null)).toBeNull();
  });
});
