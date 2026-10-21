import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyPrecommittedHoldoutFreeze } from "../src/s2-holdout-freeze.js";
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => Buffer.from(JSON.stringify(x), "utf8");
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const externalPublicKeyPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const expectedKeyFingerprintSha256 = sha(
    publicKey.export({ format: "der", type: "spki" }) as Buffer,
  );
  const manifest = {
    schemaVersion: "akp.s2.holdout-custodian-freeze.v1",
    experiment: "SECTION_SOURCE_BACKED_SHADOW",
    caseManifestSha256: sha("cases"),
    caseCount: 20,
    negativeCaseCount: 8,
    languages: { en: 10, es: 10 },
    sourceFamilies: [
      {
        publisherFamily: "nodejs",
        repository: "nodejs/node",
        commitSha: "a".repeat(40),
        sourceSnapshotSha256: sha("nodes"),
        sourceCount: 3,
      },
      {
        publisherFamily: "python",
        repository: "python/cpython",
        commitSha: "b".repeat(40),
        sourceSnapshotSha256: sha("py"),
        sourceCount: 3,
      },
    ],
    independentReviewerAssignmentsSha256: sha("sealed assignments"),
    sourceFilesNotProvidedToImplementersBeforeFreeze: true,
    frozenBeforeProviderExecution: true,
  };
  const original = bytes(manifest);
  const message = Buffer.concat([
    Buffer.from("AKP:S2:INDEPENDENT_HOLDOUT_FREEZE:V1\0"),
    original,
  ]);
  const signed = sign(null, message, privateKey);
  const input = {
    manifestBytes: original,
    precommittedManifestSha256: sha(original),
    signatureBytes: signed,
    externalPublicKeyPem,
    expectedKeyFingerprintSha256,
    excludedDevelopmentPublisherFamilies: ["mdn"],
  };
  return { manifest, input, privateKey };
}
describe("S2 externally signed holdout-family freeze verifier", () => {
  it("verifies signature and family split, but never self-certifies independence", () => {
    const r = verifyPrecommittedHoldoutFreeze(fixture().input);
    expect(r).toMatchObject({
      familyCount: 2,
      caseCount: 20,
      negativeCaseCount: 8,
      signatureVerified: true,
      familyDisjointFromExplicitDevelopmentList: true,
      independentReviewerIdentityAuthenticated: false,
      independentCustodianRoleExternallyAuthenticated: false,
      gateAccepted: false,
      releasedAnswerCorrectness: null,
      releasedFAR: null,
    });
  });
  it("rejects digest drift even if signer key is valid", () => {
    const x = fixture();
    x.input.precommittedManifestSha256 = sha("invented");
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "MANIFEST_PRECOMMIT_NOT_MATCHED",
    );
  });
  it("rejects an impostor key using a valid signature from another key", () => {
    const x = fixture();
    const stranger = generateKeyPairSync("ed25519").publicKey;
    x.input.externalPublicKeyPem = stranger
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "KEY_NOT_MATCHING_EXTERNAL_TRUST_ANCHOR",
    );
  });
  it("rejects tampered signature", () => {
    const x = fixture();
    x.input.signatureBytes = Buffer.from(x.input.signatureBytes);
    x.input.signatureBytes[0] ^= 1;
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "SIGNATURE_INVALID",
    );
  });
  it("fails closed on development publisher reuse, after valid re-signing", () => {
    const x = fixture();
    x.manifest.sourceFamilies[1]!.publisherFamily = "mdn";
    const updated = bytes(x.manifest);
    x.input.manifestBytes = updated;
    x.input.precommittedManifestSha256 = sha(updated);
    x.input.signatureBytes = sign(
      null,
      Buffer.concat([
        Buffer.from("AKP:S2:INDEPENDENT_HOLDOUT_FREEZE:V1\0"),
        updated,
      ]),
      x.privateKey,
    );
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "SOURCE_FAMILIES_NOT_DISJOINT_OR_INVALID",
    );
  });
  it("rejects freezes without both positive and negative cases", () => {
    const x = fixture();
    x.manifest.negativeCaseCount = 0;
    const b = bytes(x.manifest);
    x.input.manifestBytes = b;
    x.input.precommittedManifestSha256 = sha(b);
    x.input.signatureBytes = sign(
      null,
      Buffer.concat([Buffer.from("AKP:S2:INDEPENDENT_HOLDOUT_FREEZE:V1\0"), b]),
      x.privateKey,
    );
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "MANIFEST_SCHEMA_OR_BLINDING_INVALID",
    );
  });
  it("requires explicit precommitted independent denylist and both languages", () => {
    const x = fixture();
    x.input.excludedDevelopmentPublisherFamilies = [];
    expect(() => verifyPrecommittedHoldoutFreeze(x.input)).toThrow(
      "MISSING_PRIOR_DEVELOPMENT_DENYLIST",
    );
  });
});
