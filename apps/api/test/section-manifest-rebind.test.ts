import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SectionShadowCandidate } from "../src/section-candidate-shadow.js";
import {
  verifyPinnedSectionRebind,
  type FrozenFileBytes,
} from "../src/section-manifest-rebind.js";

const encode = (value: string) => new TextEncoder().encode(value);
const sha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const vaultId = "10000000-0000-4000-8000-000000000001";
const documentId = "20000000-0000-4000-8000-000000000002";
const sectionUnitId = "30000000-0000-4000-8000-000000000003";
const childUnitId = "40000000-0000-4000-8000-000000000004";
const revision = "revision-frozen-1";
const path = "managed/source.md";
const prefix = "---\r\ntitle: Source\r\n---\r\n";
const body = "## Contract\r\n\r\nReview required. 😀\r\nKeep the receipt.";
const raw = prefix + body;

function candidate(): SectionShadowCandidate {
  const normalized = body.replace(/\r\n?/gu, "\n");
  return {
    vaultId,
    documentId,
    revision,
    path,
    sectionUnitId,
    childUnitId,
    body: normalized,
    contentSha256: sha(normalized),
    projectionBodySha256: sha(body),
    sourceStartUtf16: 0,
    sourceEndUtf16: body.length,
    sourceSpanSha256: sha(body),
  };
}

function fixture(
  options: {
    manifestPatch?: Record<string, unknown>;
    filePatch?: Record<string, unknown>;
    candidatePatch?: Partial<SectionShadowCandidate>;
    bytes?: Uint8Array;
  } = {},
) {
  const bytes = options.bytes ?? encode(raw);
  const record = {
    vaultId,
    documentId,
    revision,
    path,
    fileSha256: sha(bytes),
    bodyStartUtf16: prefix.length,
    bodyEndUtf16: raw.length,
    ...options.filePatch,
  };
  const manifest = {
    schemaVersion: "akp.s2.section-frozen-manifest.v1",
    files: [record],
    ...options.manifestPatch,
  };
  const frozenManifestBytes = encode(JSON.stringify(manifest));
  const frozenFiles: FrozenFileBytes[] = [
    {
      vaultId,
      documentId,
      revision,
      path,
      bytes,
    },
  ];
  return {
    trustedManifestSha256: sha(frozenManifestBytes),
    frozenManifestBytes,
    frozenFiles,
    candidates: [{ ...candidate(), ...options.candidatePatch }],
  };
}

describe("externally pinned SECTION original-source manifest (offline)", () => {
  it("rebinds source file UTF-8 bytes and original UTF-16 span after frontmatter", () => {
    const result = verifyPinnedSectionRebind(fixture());
    expect(result).toMatchObject({
      schemaVersion: "akp.s2.section-pinned-manifest-rebind.v1",
      manifestPinMatched: true,
      fileCount: 1,
      externalCustodyIndependentlyAttested: false,
      gateAccepted: false,
      spanReport: {
        candidateCount: 1,
        verifiedSpanCount: 1,
        externalManifestAuthenticated: false,
        semanticSufficiencyMeasured: false,
        gateAccepted: false,
      },
    });
    expect(result.spanReport.decisions[0]?.originalSpan).toMatchObject({
      startUtf16: prefix.length,
      endUtf16: raw.length,
      spanSha256: sha(body),
    });
    const safe = JSON.stringify(result);
    expect(safe).not.toContain("Review required");
    expect(safe).not.toContain(path);
  });

  it("rejects tampered manifest under the original out-of-band pin", () => {
    const original = fixture();
    const changed = fixture({
      filePatch: { bodyStartUtf16: 0 },
    });
    expect(() =>
      verifyPinnedSectionRebind({
        ...changed,
        trustedManifestSha256: original.trustedManifestSha256,
      }),
    ).toThrow("SECTION_MANIFEST_PIN_MISMATCH");
  });

  it("rejects wrong, absent or badly formatted manifest pins", () => {
    for (const value of ["", "z".repeat(64), "a".repeat(64)]) {
      expect(() =>
        verifyPinnedSectionRebind({
          ...fixture(),
          trustedManifestSha256: value,
        }),
      ).toThrow("SECTION_MANIFEST_PIN_MISMATCH");
    }
  });

  it("rejects extra and duplicate file input", () => {
    const base = fixture();
    const extra = { ...base.frozenFiles[0]!, documentId: "other" };
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        frozenFiles: [...base.frozenFiles, extra],
      }),
    ).toThrow("SECTION_FROZEN_FILE_SET_MISMATCH");
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        frozenFiles: [base.frozenFiles[0]!, base.frozenFiles[0]!],
      }),
    ).toThrow("SECTION_FROZEN_FILE_SET_MISMATCH");
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        frozenFiles: [],
      }),
    ).toThrow("SECTION_FROZEN_FILE_SET_MISMATCH");
  });

  it("rejects unexpected and duplicated manifest records", () => {
    const base = fixture();
    const parsed = JSON.parse(
      new TextDecoder().decode(base.frozenManifestBytes),
    );
    parsed.files.push(parsed.files[0]);
    const newBytes = encode(JSON.stringify(parsed));
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        trustedManifestSha256: sha(newBytes),
        frozenManifestBytes: newBytes,
      }),
    ).toThrow("SECTION_MANIFEST_DUPLICATE_FILE");
    expect(() =>
      verifyPinnedSectionRebind(
        fixture({ manifestPatch: { schemaVersion: "wrong" } }),
      ),
    ).toThrow("SECTION_MANIFEST_INVALID");
  });

  it("refuses unpinned file mutations even if the scope still matches", () => {
    const base = fixture();
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        frozenFiles: [
          {
            ...base.frozenFiles[0]!,
            bytes: encode(raw + "tampered"),
          },
        ],
      }),
    ).toThrow("SECTION_FROZEN_FILE_HASH_MISMATCH");
  });

  it("rejects invalid UTF-8 even when hash is correctly pinned", () => {
    const modified = fixture({
      bytes: Uint8Array.from([0xff, 0xfe, 0xfa]),
    });
    expect(() => verifyPinnedSectionRebind(modified)).toThrow(
      "SECTION_FROZEN_FILE_ENCODING_INVALID",
    );
  });

  it("rejects unknown metadata, traversal, absolute and Windows paths", () => {
    for (const patch of [
      { path: "../private.md" },
      { path: "C:\\secrets\\private.md" },
      { path: "/absolute.md" },
      { unexpected: "value" },
    ]) {
      expect(() =>
        verifyPinnedSectionRebind(fixture({ filePatch: patch })),
      ).toThrow("SECTION_MANIFEST_INVALID");
    }
  });

  it("fails candidate set mismatches and duplicated candidate identity", () => {
    const base = fixture();
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        candidates: [{ ...candidate(), path: "other.md" }],
      }),
    ).toThrow("SECTION_CANDIDATE_MANIFEST_SCOPE_MISMATCH");
    expect(() =>
      verifyPinnedSectionRebind({
        ...base,
        candidates: [candidate(), candidate()],
      }),
    ).toThrow("DUPLICATE_SECTION_CANDIDATE");
  });

  it("returns explicit nonverified span status without treating pin as semantic support", () => {
    const result = verifyPinnedSectionRebind(
      fixture({
        filePatch: { bodyStartUtf16: 0 },
      }),
    );
    expect(result.spanReport.verifiedSpanCount).toBe(0);
    expect(result.spanReport.decisions[0]?.status).toBe(
      "ORIGINAL_BODY_PROJECTION_MISMATCH",
    );
    expect(result.gateAccepted).toBe(false);
  });

  it("keeps a UTF-8 BOM in the raw original file coordinate frame", () => {
    const bom = "\ufeff";
    const file = bom + raw;
    const f = fixture({
      bytes: encode(file),
      filePatch: {
        bodyStartUtf16: bom.length + prefix.length,
        bodyEndUtf16: file.length,
      },
    });
    expect(verifyPinnedSectionRebind(f).spanReport.verifiedSpanCount).toBe(1);
  });

  it("rejects an empty or oversized manifest even with a matching supplied digest", () => {
    for (const rawBytes of [new Uint8Array(), new Uint8Array(256_001)]) {
      expect(() =>
        verifyPinnedSectionRebind({
          ...fixture(),
          frozenManifestBytes: rawBytes,
          trustedManifestSha256: sha(rawBytes),
        }),
      ).toThrow("SECTION_MANIFEST_PIN_MISMATCH");
    }
  });
});
