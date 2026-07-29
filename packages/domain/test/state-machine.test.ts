import { describe, expect, it } from "vitest";
import { transitionIngest } from "../src/index.js";

describe("ingest state machine", () => {
  it("allows valid transitions", () => {
    expect(transitionIngest("RECEIVED", "HASHED")).toBe("HASHED");
  });

  it("fails closed on skipped publication stages", () => {
    expect(() => transitionIngest("RECEIVED", "MERGED")).toThrow(
      /Invalid ingest transition/,
    );
  });
});
