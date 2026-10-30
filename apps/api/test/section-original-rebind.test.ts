import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  rebindSectionsToFrozenOriginal,
  type IndependentlyFrozenSectionFile,
} from "../src/section-original-rebind.js";
import type { SectionShadowCandidate } from "../src/section-candidate-shadow.js";

const digest = (content: string): string =>
  createHash("sha256").update(content).digest("hex");

const vaultId = "10000000-0000-4000-8000-000000000001";
const documentId = "20000000-0000-4000-8000-000000000002";
const sectionUnitId = "30000000-0000-4000-8000-000000000003";
const childUnitId = "40000000-0000-4000-8000-000000000004";
const path = "notes/protocol.md";
const revision = "r1";
const frontmatter = "---\r\ntitle: Protocol\r\n---\r\n";
const body = "## Protocol\r\n\r\nApprove first. 😀\r\nKeep an audit log.";
const originalFileText = frontmatter + body;
const normalized = body.replace(/\r\n?/gu, "\n");

function section(
  overrides: Partial<SectionShadowCandidate> = {},
): SectionShadowCandidate {
  return {
    vaultId,
    documentId,
    childUnitId,
    sectionUnitId,
    revision,
    path,
    body: normalized,
    contentSha256: digest(normalized),
    projectionBodySha256: digest(body),
    sourceStartUtf16: 0,
    sourceEndUtf16: body.length,
    sourceSpanSha256: digest(body),
    ...overrides,
  };
}
function frozen(
  overrides: Partial<IndependentlyFrozenSectionFile> = {},
): IndependentlyFrozenSectionFile {
  return {
    vaultId,
    documentId,
    revision,
    path,
    fileText: originalFileText,
    fileSha256: digest(originalFileText),
    bodyStartUtf16: frontmatter.length,
    bodyEndUtf16: originalFileText.length,
    ...overrides,
  };
}

describe("SECTION original-file UTF-16 rebinding (offline, not admission)", () => {
  it("rebinds exact raw CRLF+Unicode offsets after frontmatter", () => {
    const report = rebindSectionsToFrozenOriginal([section()], [frozen()]);
    expect(report).toMatchObject({
      schemaVersion: "akp.s2.section-original-rebind.v1",
      candidateCount: 1,
      verifiedSpanCount: 1,
      externalManifestAuthenticated: false,
      semanticSufficiencyMeasured: false,
      gateAccepted: false,
    });
    expect(report.decisions[0]).toMatchObject({
      status: "FROZEN_FILE_SPAN_MATCHED",
      originalSpan: {
        startUtf16: frontmatter.length,
        endUtf16: originalFileText.length,
        spanSha256: digest(body),
      },
    });
    expect(JSON.stringify(report)).not.toContain("Approve first");
    expect(JSON.stringify(report)).not.toContain(path);
  });

  it.each([
    [
      "wrong original file digest",
      [frozen({ fileSha256: digest("wrong") })],
      "ORIGINAL_FILE_HASH_MISMATCH",
    ],
    [
      "tampered original file",
      [frozen({ fileText: originalFileText + " changed" })],
      "ORIGINAL_FILE_HASH_MISMATCH",
    ],
    [
      "mismatched body start",
      [frozen({ bodyStartUtf16: 0 })],
      "ORIGINAL_BODY_PROJECTION_MISMATCH",
    ],
    [
      "impossible body frame",
      [frozen({ bodyEndUtf16: frontmatter.length - 1 })],
      "ORIGINAL_BODY_FRAME_INVALID",
    ],
    ["no snapshot", [], "REVISION_IDENTITY_MISMATCH"],
  ] as const)("rejects %s", (_reason, source, expected) => {
    const result = rebindSectionsToFrozenOriginal([section()], source);
    expect(result.verifiedSpanCount).toBe(0);
    expect(result.decisions[0]?.status).toBe(expected);
  });

  it("rejects wrong projection hash, source-span hash and normalized body independently", () => {
    for (const [candidate, reason] of [
      [
        section({ projectionBodySha256: digest("different") }),
        "ORIGINAL_BODY_PROJECTION_MISMATCH",
      ],
      [
        section({ sourceSpanSha256: digest("different") }),
        "ORIGINAL_SPAN_HASH_MISMATCH",
      ],
      [
        section({ body: "Altered", contentSha256: digest("Altered") }),
        "ORIGINAL_SECTION_TEXT_MISMATCH",
      ],
      [
        section({ contentSha256: digest("different") }),
        "ORIGINAL_SECTION_TEXT_MISMATCH",
      ],
    ] as const) {
      const report = rebindSectionsToFrozenOriginal([candidate], [frozen()]);
      expect(report.decisions[0]?.status).toBe(reason);
      expect(report.verifiedSpanCount).toBe(0);
    }
  });

  it("rejects UTF-16 surrogate splits, inverted ranges and foreign paths", () => {
    const emoji = body.indexOf("😀");
    expect(emoji).toBeGreaterThan(0);
    expect(
      rebindSectionsToFrozenOriginal(
        [section({ sourceStartUtf16: emoji + 1 })],
        [frozen()],
      ).decisions[0]?.status,
    ).toBe("ORIGINAL_SPAN_OUT_OF_BOUNDS");
    expect(
      rebindSectionsToFrozenOriginal(
        [section({ sourceEndUtf16: 0 })],
        [frozen()],
      ).decisions[0]?.status,
    ).toBe("ORIGINAL_SPAN_OUT_OF_BOUNDS");
    expect(() =>
      rebindSectionsToFrozenOriginal(
        [section({ path: "private/other.md" })],
        [frozen()],
      ),
    ).toThrow("UNEXPECTED_FROZEN_SOURCE");
  });

  it("refuses a frozen source with a mismatched revision", () => {
    expect(() =>
      rebindSectionsToFrozenOriginal([section()], [frozen({ revision: "r0" })]),
    ).toThrow("UNEXPECTED_FROZEN_SOURCE");
  });

  it("refuses duplicated sources or section identities", () => {
    expect(() =>
      rebindSectionsToFrozenOriginal([section()], [frozen(), frozen()]),
    ).toThrow("DUPLICATE_FROZEN_SOURCE");
    expect(() =>
      rebindSectionsToFrozenOriginal([section(), section()], [frozen()]),
    ).toThrow("DUPLICATE_SECTION_CANDIDATE");
    expect(() =>
      rebindSectionsToFrozenOriginal(
        [section()],
        [
          frozen(),
          frozen({ documentId: "99999999-0000-4000-8000-000000000009" }),
        ],
      ),
    ).toThrow("UNEXPECTED_FROZEN_SOURCE");
  });

  it("distinguishes file body offsets from historical source-projection coordinates", () => {
    const report = rebindSectionsToFrozenOriginal(
      [
        section({
          sourceStartUtf16: 0,
          sourceEndUtf16: 2,
          sourceSpanSha256: digest(body.slice(0, 2)),
          body: "##",
          contentSha256: digest("##"),
        }),
      ],
      [frozen()],
    );
    expect(report.decisions[0]?.originalSpan?.startUtf16).toBe(
      frontmatter.length,
    );
    expect(report.decisions[0]?.originalSpan?.endUtf16).toBe(
      frontmatter.length + 2,
    );
  });
});
