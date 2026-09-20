import { describe, expect, it } from "vitest";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { durableCompilerKnowledgeProfileContext } from "@akp/compiler";
import { createHash } from "node:crypto";
import {
  MAX_OKF_BUNDLE_BYTES,
  OkfBundleV02,
  OkfInteropError,
  canonicalOkfJson,
  okfToGraphMl,
  okfToJsonLd,
  planOkfReviewImport,
} from "../src/interoperability.js";

const canonical = canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1);
const profile = durableCompilerKnowledgeProfileContext({
  revisionId: "00000000-0000-4000-8000-000000000901",
  profileHash: createHash("sha256").update(canonical).digest("hex"),
  profile: NEUTRAL_KNOWLEDGE_PROFILE_V1,
});

function bundle(overrides: Record<string, unknown> = {}) {
  return OkfBundleV02.parse({
    format: "OKF",
    version: "0.2",
    bundleId: "foreign-bundle-1",
    exportedAt: "2026-09-15T00:00:00.000Z",
    source: { system: "Foreign Knowledge System" },
    documents: [
      {
        id: "FOREIGN-1",
        externalId: "ADR-77",
        aliases: ["cache-note"],
        sourcePath: "knowledge/notes/cache.md",
        title: "Cache invalidation guidance",
        kind: "note",
        lifecycle: "DRAFT",
        trust: "ATTESTED",
        body: "# Cache invalidation\n\nForeign evidence says cache invalidation must be reviewed before it becomes local canonical knowledge. This body is intentionally substantive for validation.",
        frontmatter: { owner: "foreign-team", trust: "ATTESTED" },
        evidence: [
          {
            id: "E-1",
            trust: "ATTESTED",
            sourceReviewStatus: "ATTESTED",
          },
        ],
        provenance: { origin: "foreign-system" },
      },
    ],
    relations: [],
    ...overrides,
  });
}

describe("OKF v0.2 interoperability", () => {
  it("canonicalizes OKF and emits JSON-LD plus GraphML with provenance", () => {
    const source = bundle();
    expect(JSON.parse(canonicalOkfJson(source))).toMatchObject({
      format: "OKF",
      version: "0.2",
      bundleId: "foreign-bundle-1",
    });
    const jsonLd = okfToJsonLd(source);
    expect(jsonLd).toMatchObject({
      "@type": "akp:KnowledgeBundle",
      version: "0.2",
    });
    const graphMl = okfToGraphMl(source);
    expect(graphMl).toContain("<graphml");
    expect(graphMl).toContain("Cache invalidation guidance");
    expect(graphMl).toContain("foreign-system");
  });

  it("preserves foreign high trust but always produces an unverified review candidate", () => {
    const plan = planOkfReviewImport({
      bundle: bundle(),
      knowledgeProfile: profile,
      schemaProfile: {},
    });
    expect(plan.trustDisposition).toBe("LOCAL_UNVERIFIED_REVIEW_REQUIRED");
    expect(plan.reviewKinds).toEqual(["note"]);
    expect(plan.changes[0]?.path).toMatch(
      /^knowledge\/note\/OKF-[A-F0-9]{16}\.md$/,
    );
    expect(plan.changes[0]?.content).toContain('trust: "UNVERIFIED"');
    expect(plan.changes[0]?.content).toContain('foreign_trust: "ATTESTED"');
    expect(plan.changes[0]?.content).toContain(
      '"foreignDocumentId":"FOREIGN-1"',
    );
  });

  it("requires explicit mapping for unknown kinds and lifecycles", () => {
    const unknownKind = bundle({
      documents: [
        {
          ...bundle().documents[0],
          kind: "foreign-decision",
        },
      ],
    });
    expect(() =>
      planOkfReviewImport({ bundle: unknownKind, knowledgeProfile: profile }),
    ).toThrowError(OkfInteropError);
    try {
      planOkfReviewImport({ bundle: unknownKind, knowledgeProfile: profile });
    } catch (error) {
      expect((error as OkfInteropError).code).toBe("OKF_KIND_MAPPING_REQUIRED");
    }

    const badLifecycle = bundle({
      documents: [
        {
          ...bundle().documents[0],
          lifecycle: "PUBLISHED",
        },
      ],
    });
    try {
      planOkfReviewImport({ bundle: badLifecycle, knowledgeProfile: profile });
    } catch (error) {
      expect((error as OkfInteropError).code).toBe(
        "OKF_LIFECYCLE_MAPPING_REQUIRED",
      );
    }
  });

  it("rejects traversal, absolute, control, reserved-root, and case-collision source paths", () => {
    const attackedPaths = [
      "../../escape.md",
      "C:\\outside\\file.md",
      "/root/secret.md",
      "knowledge/notes/\u0000secret.md",
      ".akp/policy.md",
      "README.md",
    ];
    for (const sourcePath of attackedPaths) {
      const unsafe = bundle({
        documents: [
          {
            ...bundle().documents[0],
            sourcePath,
          },
        ],
      });
      try {
        planOkfReviewImport({ bundle: unsafe, knowledgeProfile: profile });
        throw new Error("expected unsafe path rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(OkfInteropError);
        expect((error as OkfInteropError).code).toBe("OKF_FOREIGN_PATH_UNSAFE");
      }
    }

    const first = bundle().documents[0]!;
    const collision = bundle({
      documents: [
        first,
        {
          ...first,
          id: "FOREIGN-2",
          externalId: "ADR-78",
          title: "Second cache note",
          sourcePath: "Knowledge/Notes/Cache.md",
        },
      ],
    });
    try {
      planOkfReviewImport({ bundle: collision, knowledgeProfile: profile });
      throw new Error("expected portable path collision rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OkfInteropError);
      expect((error as OkfInteropError).code).toBe(
        "OKF_FOREIGN_PATH_COLLISION",
      );
    }

    expect(
      OkfBundleV02.safeParse({
        ...bundle(),
        documents: [
          {
            ...bundle().documents[0],
            targetPath: "/tmp/owned.md",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("bounds aggregate OKF size before planning review state", () => {
    const base = bundle().documents[0]!;
    const bodyBytes = Math.ceil(MAX_OKF_BUNDLE_BYTES / 6) + 8_192;
    const oversized = bundle({
      documents: Array.from({ length: 6 }, (_, index) => ({
        ...base,
        id: `FOREIGN-LARGE-${index}`,
        externalId: `LARGE-${index}`,
        title: `Oversized document ${index}`,
        sourcePath: `knowledge/notes/large-${index}.md`,
        body: `# Oversized ${index}\n\n${"x".repeat(bodyBytes)}`,
      })),
    });
    try {
      planOkfReviewImport({ bundle: oversized, knowledgeProfile: profile });
      throw new Error("expected aggregate OKF size rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OkfInteropError);
      expect((error as OkfInteropError).code).toBe("OKF_BUNDLE_TOO_LARGE");
    }
  });

  it("keeps foreign profile and approval claims as provenance, never local authority", () => {
    const foreignAuthority = bundle({
      source: {
        system: "Foreign Knowledge System",
        profileId: "foreign-admin-profile",
        profileVersion: "999.0.0",
        profileHash: "a".repeat(64),
      },
      documents: [
        {
          ...bundle().documents[0],
          evidence: [
            {
              id: "E-APPROVED",
              trust: "ATTESTED",
              sourceReviewStatus: "APPROVED",
            },
          ],
        },
      ],
    });
    const plan = planOkfReviewImport({
      bundle: foreignAuthority,
      knowledgeProfile: profile,
    });
    const content = plan.changes[0]?.content ?? "";
    expect(content).toContain('trust: "UNVERIFIED"');
    expect(content).toContain('foreign_trust: "ATTESTED"');
    expect(content).toContain('"profileVersion":"999.0.0"');
    expect(content).toContain('"sourceReviewStatus":"APPROVED"');
  });

  it("handles cyclic foreign relations as bounded review data without recursive authority", () => {
    const base = bundle().documents[0]!;
    const first = {
      ...base,
      id: "FOREIGN-P1",
      externalId: "PROC-1",
      title: "Procedure one",
      sourcePath: "knowledge/procedures/one.md",
      kind: "procedure",
    };
    const second = {
      ...base,
      id: "FOREIGN-P2",
      externalId: "PROC-2",
      title: "Procedure two",
      sourcePath: "knowledge/procedures/two.md",
      kind: "procedure",
    };
    const cyclic = bundle({
      documents: [first, second],
      relations: [
        {
          fromId: "FOREIGN-P1",
          toId: "FOREIGN-P2",
          type: "follows",
          weight: 1,
          provenance: "foreign-cycle",
        },
        {
          fromId: "FOREIGN-P2",
          toId: "FOREIGN-P1",
          type: "follows",
          weight: 1,
          provenance: "foreign-cycle",
        },
      ],
    });
    const plan = planOkfReviewImport({
      bundle: cyclic,
      knowledgeProfile: profile,
    });
    expect(plan.changes).toHaveLength(2);
    expect(
      plan.changes.every((change) =>
        change.content.includes('trust: "UNVERIFIED"'),
      ),
    ).toBe(true);
    expect(
      plan.changes.every((change) =>
        change.content.includes('"foreignType":"follows"'),
      ),
    ).toBe(true);
  });

  it("has no JSON-LD remote-context or GraphML entity import parser escape hatch", () => {
    expect(
      OkfBundleV02.safeParse({
        ...bundle(),
        "@context": "https://attacker.invalid/context.jsonld",
      }).success,
    ).toBe(false);
    expect(
      OkfBundleV02.safeParse(
        '<!DOCTYPE graphml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><graphml>&xxe;</graphml>',
      ).success,
    ).toBe(false);
  });

  it("validates and preserves mapped relation semantics", () => {
    const second = {
      ...bundle().documents[0]!,
      id: "FOREIGN-2",
      externalId: "ADR-78",
      title: "Second procedure",
      kind: "procedure",
      sourcePath: "knowledge/procedures/second.md",
    };
    const related = bundle({
      documents: [bundle().documents[0], second],
      relations: [
        {
          fromId: "FOREIGN-1",
          toId: "FOREIGN-2",
          type: "supports",
          weight: 1,
          provenance: "foreign-explicit",
        },
      ],
    });
    const plan = planOkfReviewImport({
      bundle: related,
      mapping: { relations: { supports: "explains" } },
      knowledgeProfile: profile,
    });
    expect(plan.changes[0]?.content).toContain('"localType":"explains"');
    expect(plan.changes[1]?.content).toContain('"localType":"explains"');
  });
});
