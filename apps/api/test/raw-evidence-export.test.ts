import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ObjectStore, RawObjectRef } from "@akp/object-store";
import {
  RAW_EVIDENCE_EXPORT_CONFIRMATION,
  RawEvidenceExportError,
  parseRawEvidenceLocator,
  rawEvidenceContentDisposition,
  readAndVerifyRawEvidence,
} from "../src/routes/audit-export.js";

const bytes = Buffer.from("raw evidence fixture\n", "utf8");
const sha256 = "b".repeat(64);
const actualSha256 = createHash("sha256").update(bytes).digest("hex");
const ref: RawObjectRef = {
  bucket: "test",
  key: `sha256/${actualSha256.slice(0, 2)}/${actualSha256}`,
  sha256: actualSha256,
  bytes: bytes.byteLength,
  mediaType: "text/plain",
};

function fakeStore(payload = bytes): ObjectStore {
  return {
    async putImmutable() {
      throw new Error("not used");
    },
    async get() {
      return Readable.from([payload]);
    },
    async exists() {
      return ref;
    },
  };
}

describe("raw evidence export safety boundary", () => {
  it("requires a structured locator and preserves the distinct confirmation", () => {
    expect(RAW_EVIDENCE_EXPORT_CONFIRMATION).toBe("EXPORT_RAW_EVIDENCE");
    expect(parseRawEvidenceLocator('{"page":2,"kind":"pdf"}')).toEqual({
      page: 2,
      kind: "pdf",
    });
    expect(() => parseRawEvidenceLocator("[]")).toThrow(
      "INVALID_EVIDENCE_LOCATOR",
    );
    expect(
      rawEvidenceContentDisposition("11111111-1111-4111-8111-111111111111"),
    ).toBe(
      'attachment; filename="akp-evidence-11111111-1111-4111-8111-111111111111.bin"',
    );
  });

  it("hashes and bounds the object before it can be returned", async () => {
    const verified = await readAndVerifyRawEvidence(
      fakeStore(),
      ref,
      {
        sha256: actualSha256,
        byteSize: bytes.byteLength,
        objectKey: ref.key,
      },
      1024,
    );
    expect(verified).toMatchObject({
      sha256: actualSha256,
      bytes,
    });
    await expect(
      readAndVerifyRawEvidence(
        fakeStore(),
        ref,
        {
          sha256,
          byteSize: bytes.byteLength,
          objectKey: ref.key,
        },
        1024,
      ),
    ).rejects.toMatchObject({ code: "RAW_EVIDENCE_INTEGRITY_FAILED" });
  });

  it("rejects object metadata that exceeds the caller limit", async () => {
    await expect(
      readAndVerifyRawEvidence(
        fakeStore(),
        ref,
        {
          sha256,
          byteSize: bytes.byteLength,
          objectKey: ref.key,
        },
        2,
      ),
    ).rejects.toMatchObject({ code: "RAW_EVIDENCE_TOO_LARGE" });
  });
});
