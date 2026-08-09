import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashFile } from "../src/index.js";

describe("hashFile", () => {
  it("returns a deterministic SHA-256 and byte count", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "akp-hash-"));
    try {
      const file = path.join(directory, "source.md");
      await writeFile(file, "architecture knowledge", "utf8");
      await expect(hashFile(file)).resolves.toEqual({
        sha256:
          "0ce0ca6c28dc41efe654621169816c64fa2803e60ae3eb20bc342b7a64b76b27",
        bytes: 22,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
