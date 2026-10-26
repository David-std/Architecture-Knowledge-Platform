import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ObjectStore, RawObjectRef } from "@akp/object-store";
import type { GovernedTemporalEvidenceReference } from "@akp/postgres";
import { verifyGovernedRawSourceExcerpt } from "../src/governed-source-integrity.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const excerpt = "Access requires MFA.";
const raw = Buffer.from("# Policy\nAccess requires MFA.\n", "utf8");
const hash = createHash("sha256").update(raw).digest("hex");
const ref: RawObjectRef = {
  sha256: hash,
  key: `sha256/${hash.slice(0, 2)}/${hash}`,
  bucket: "shadow-source",
  bytes: raw.byteLength,
  mediaType: "text/markdown",
};
const evidence: GovernedTemporalEvidenceReference = {
  id: "22222222-2222-4222-8222-222222222222",
  spaceId: "33333333-3333-4333-8333-333333333333",
  vaultId: "44444444-4444-4444-8444-444444444444",
  sourceId,
  artifactId: null,
  locator: { kind: "source", source_hash: hash, path: `source:${sourceId}` },
  contentHash: createHash("sha256").update(excerpt).digest("hex"),
  excerpt,
  sourceSha256: hash,
  sourceObjectKey: ref.key,
  sourceByteSize: String(raw.byteLength),
  sourceMediaType: "text/markdown",
};

function store(
  bytes = raw,
  options: { missing?: boolean; inaccessible?: boolean } = {},
): ObjectStore {
  return {
    async putImmutable() {
      throw new Error("not used");
    },
    async exists() {
      return options.missing ? null : ref;
    },
    async get() {
      if (options.inaccessible) throw new Error("SOURCE_UNAVAILABLE");
      return Readable.from([bytes]);
    },
  };
}

describe("governed immutable raw SOURCE textual evidence", () => {
  it("re-hashes original bytes and binds a unique literal excerpt", async () => {
    expect(await verifyGovernedRawSourceExcerpt(store(), evidence)).toBe(true);
  });

  it("rejects changed raw bytes, duplicated excerpts and invalid UTF-8", async () => {
    expect(
      await verifyGovernedRawSourceExcerpt(
        store(Buffer.from("# Changed\nDifferent value.\n")),
        evidence,
      ),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(
        store(Buffer.from(raw.toString("utf8") + excerpt)),
        evidence,
      ),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(
        store(Buffer.from([0xff])),
        evidence,
      ),
    ).toBe(false);
  });

  it("rejects changed key, size, locator and non-text formats", async () => {
    expect(
      await verifyGovernedRawSourceExcerpt(store(), {
        ...evidence,
        sourceObjectKey: "another-object",
      }),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(store(), {
        ...evidence,
        sourceByteSize: "99999999",
      }),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(store(), {
        ...evidence,
        locator: { kind: "source", source_hash: hash, path: "source:foreign" },
      }),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(store(), {
        ...evidence,
        locator: { kind: "paragraph", source_hash: hash, path: "doc.md" },
      }),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(store(), {
        ...evidence,
        sourceMediaType: "application/pdf",
      }),
    ).toBe(false);
  });

  it("fails closed when immutable storage is unavailable", async () => {
    expect(
      await verifyGovernedRawSourceExcerpt(
        store(raw, { missing: true }),
        evidence,
      ),
    ).toBe(false);
    expect(
      await verifyGovernedRawSourceExcerpt(
        store(raw, { inaccessible: true }),
        evidence,
      ),
    ).toBe(false);
  });
});
