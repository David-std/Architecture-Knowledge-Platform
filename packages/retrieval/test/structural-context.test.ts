import { describe, expect, it } from "vitest";
import { rehydrateStructuralContext } from "../src/structural-context.js";

describe("rehydrateStructuralContext", () => {
  it("rehydrates an atomic unit from a bounded section parent", () => {
    const child = "A rule must preserve its evidence locator.";
    const result = rehydrateStructuralContext(
      {
        body: child,
        unitType: "RULE",
        parentBody: `# Evidence rules\n\n${"context ".repeat(300)}\n${child}\n${"tail ".repeat(300)}`,
        parentUnitType: "SECTION",
      },
      600,
    );

    expect(result).toContain(child);
    expect(result.length).toBeLessThanOrEqual(600);
  });

  it("focuses a long matched unit on the lexical passage instead of its prefix", () => {
    const decisive =
      "Peer revocation sets the peer to DISABLED and removes its credential reference.";
    const result = rehydrateStructuralContext(
      {
        body: `${"introductory federation context ".repeat(120)}\n${decisive}\n${"tail context ".repeat(120)}`,
        unitType: "PARAGRAPH",
        focusText: "peer revocation credential reference",
      },
      600,
    );

    expect(result).toContain(decisive);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).not.toMatch(/^introductory federation context/u);
  });

  it("falls back deterministically when focus terms do not occur", () => {
    const body = `${"prefix ".repeat(200)}\nlate material`;
    const result = rehydrateStructuralContext(
      {
        body,
        unitType: "PARAGRAPH",
        focusText: "unrelated semantic paraphrase",
      },
      120,
    );

    expect(result).toBe(`${body.slice(0, 119).trimEnd()}…`);
  });

  it("rehydrates a table row from its structural table parent", () => {
    const parent = [
      "| Key | Action |",
      "| --- | --- |",
      "| item-1 | routine observation |",
      "| item-20 | route to isolated recovery |",
      "| item-21 | routine observation |",
    ].join("\n");
    const child = "| item-20 | route to isolated recovery |";
    const result = rehydrateStructuralContext(
      {
        body: child,
        unitType: "TABLE_ROW",
        parentBody: parent,
        parentUnitType: "TABLE",
        focusText: "item-20 isolated recovery",
      },
      150,
    );

    expect(result).toContain("| Key | Action |");
    expect(result).toContain(child);
    expect(result.length).toBeLessThanOrEqual(150);
  });

  it("never expands a DOCUMENT container into the packet", () => {
    const child = "Only this atomic table row is relevant.";
    const result = rehydrateStructuralContext({
      body: child,
      unitType: "TABLE",
      parentBody: `Entire dossier ${"x".repeat(20_000)}`,
      parentUnitType: "DOCUMENT",
    });

    expect(result).toBe(child);
    expect(result).not.toContain("Entire dossier");
  });
});
