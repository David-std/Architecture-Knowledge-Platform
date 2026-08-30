import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveAuthorizedLocalSource } from "../src/source-boundary.js";

describe("worker source boundary", () => {
  it("requires explicit roots and rejects empty components", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-source-boundary-"));
    const file = path.join(root, "fixture.md");
    await writeFile(file, "# fixture", "utf8");
    await expect(resolveAuthorizedLocalSource(file, undefined)).rejects.toThrow(
      "SOURCE_PATH_NOT_ALLOWED",
    );
    await expect(
      resolveAuthorizedLocalSource(file, `${root}${path.delimiter}`),
    ).rejects.toThrow("SOURCE_PATH_NOT_ALLOWED");
  });

  it("allows a regular file below a canonical root and rejects traversal/symlinks outside it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-source-boundary-"));
    const outside = await mkdtemp(path.join(tmpdir(), "akp-source-outside-"));
    const file = path.join(root, "fixture.md");
    const outsideFile = path.join(outside, "secret.md");
    await writeFile(file, "# fixture", "utf8");
    await writeFile(outsideFile, "secret", "utf8");
    await expect(resolveAuthorizedLocalSource(file, root)).resolves.toBe(file);
    await expect(
      resolveAuthorizedLocalSource(path.join(root, "..", "secret.md"), root),
    ).rejects.toThrow("SOURCE_PATH_NOT_ALLOWED");
    const link = path.join(root, "link.md");
    try {
      await symlink(outsideFile, link, "file");
      await expect(resolveAuthorizedLocalSource(link, root)).rejects.toThrow(
        "SOURCE_PATH_NOT_ALLOWED",
      );
    } catch (error) {
      // Windows environments without symlink privileges still exercise the
      // explicit-root and traversal assertions above.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("rejects remote URLs before touching the filesystem", async () => {
    await expect(
      resolveAuthorizedLocalSource("http://127.0.0.1:19000/health", "C:/"),
    ).rejects.toThrow("Remote URLs require");
  });
});
