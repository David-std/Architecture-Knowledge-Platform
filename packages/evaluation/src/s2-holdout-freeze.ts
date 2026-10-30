import { createHash, createPublicKey, verify } from "node:crypto";

/** Signature and family separation alone NEVER authenticate institutional independence. */
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const hex = /^[a-f0-9]{64}$/u,
  rev = /^[a-f0-9]{40}$/u;
const fail = (x: string): never => {
  throw Error("S2_HOLDOUT_FREEZE_" + x);
};
const obj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).sort().join(",") === fields.sort().join(",");
export interface HoldoutCustodianFreeze {
  schemaVersion: "akp.s2.holdout-custodian-freeze.v1";
  experiment: "SECTION_SOURCE_BACKED_SHADOW";
  caseManifestSha256: string;
  caseCount: number;
  negativeCaseCount: number;
  languages: { en: number; es: number };
  sourceFamilies: {
    publisherFamily: string;
    repository: string;
    commitSha: string;
    sourceSnapshotSha256: string;
    sourceCount: number;
  }[];
  independentReviewerAssignmentsSha256: string;
  sourceFilesNotProvidedToImplementersBeforeFreeze: boolean;
  frozenBeforeProviderExecution: boolean;
}
export interface HoldoutFreezeReport {
  schemaVersion: "akp.s2.holdout-freeze-audit.v1";
  status: "SIGNED_FAMILY_DISJOINT_FREEZE_STRUCTURALLY_VERIFIED";
  rawManifestSha256: string;
  signatureVerified: true;
  trustedPublicKeyFingerprintMatched: true;
  familyDisjointFromExplicitDevelopmentList: true;
  familyCount: number;
  caseCount: number;
  negativeCaseCount: number;
  languages: { en: number; es: number };
  independentReviewerIdentityAuthenticated: false;
  independentCustodianRoleExternallyAuthenticated: false;
  holdoutAdjudicationPerformed: false;
  releasedAnswerCorrectness: null;
  releasedFAR: null;
  gateAccepted: false;
}
/**
 * The trust anchor (expected key fingerprint, development family denylist,
 * frozen raw manifest pin) must come from OUTSIDE the submitted artifact.
 * Verifying an Ed25519 signature does not prove signer's employment, independence,
 * authority or blinded behavior.
 */
export function verifyPrecommittedHoldoutFreeze(input: {
  manifestBytes: Uint8Array;
  precommittedManifestSha256: string;
  signatureBytes: Uint8Array;
  externalPublicKeyPem: string;
  expectedKeyFingerprintSha256: string;
  excludedDevelopmentPublisherFamilies: readonly string[];
}): HoldoutFreezeReport {
  if (
    !hex.test(input.precommittedManifestSha256) ||
    !hex.test(input.expectedKeyFingerprintSha256) ||
    sha(input.manifestBytes) !== input.precommittedManifestSha256 ||
    input.manifestBytes.byteLength === 0 ||
    input.manifestBytes.byteLength > 500_000
  )
    fail("MANIFEST_PRECOMMIT_NOT_MATCHED");
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(input.externalPublicKeyPem);
  } catch {
    throw new Error("S2_HOLDOUT_FREEZE_PUBLIC_KEY_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("EXPECTED_ED25519_KEY");
  const fingerprint = sha(
    publicKey.export({ format: "der", type: "spki" }) as Buffer,
  );
  if (fingerprint !== input.expectedKeyFingerprintSha256)
    fail("KEY_NOT_MATCHING_EXTERNAL_TRUST_ANCHOR");
  const domain = Buffer.concat([
    Buffer.from("AKP:S2:INDEPENDENT_HOLDOUT_FREEZE:V1\0", "utf8"),
    Buffer.from(input.manifestBytes),
  ]);
  if (
    input.signatureBytes.byteLength !== 64 ||
    !verify(null, domain, publicKey, input.signatureBytes)
  )
    fail("SIGNATURE_INVALID");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.manifestBytes),
    ) as unknown;
  } catch {
    fail("MANIFEST_INVALID_JSON");
  }
  if (!obj(manifest))
    throw new Error("S2_HOLDOUT_FREEZE_MANIFEST_SCHEMA_OR_BLINDING_INVALID");
  if (
    !obj(manifest) ||
    !keys(manifest, [
      "schemaVersion",
      "experiment",
      "caseManifestSha256",
      "caseCount",
      "negativeCaseCount",
      "languages",
      "sourceFamilies",
      "independentReviewerAssignmentsSha256",
      "sourceFilesNotProvidedToImplementersBeforeFreeze",
      "frozenBeforeProviderExecution",
    ]) ||
    manifest.schemaVersion !== "akp.s2.holdout-custodian-freeze.v1" ||
    manifest.experiment !== "SECTION_SOURCE_BACKED_SHADOW" ||
    !hex.test(String(manifest.caseManifestSha256)) ||
    !hex.test(String(manifest.independentReviewerAssignmentsSha256)) ||
    !Number.isSafeInteger(manifest.caseCount) ||
    Number(manifest.caseCount) < 1 ||
    !Number.isSafeInteger(manifest.negativeCaseCount) ||
    Number(manifest.negativeCaseCount) < 1 ||
    Number(manifest.negativeCaseCount) >= Number(manifest.caseCount) ||
    !obj(manifest.languages) ||
    !keys(manifest.languages, ["en", "es"]) ||
    !Number.isSafeInteger(manifest.languages.en) ||
    !Number.isSafeInteger(manifest.languages.es) ||
    Number(manifest.languages.en) < 1 ||
    Number(manifest.languages.es) < 1 ||
    Number(manifest.languages.en) + Number(manifest.languages.es) !==
      manifest.caseCount ||
    manifest.sourceFilesNotProvidedToImplementersBeforeFreeze !== true ||
    manifest.frozenBeforeProviderExecution !== true ||
    !Array.isArray(manifest.sourceFamilies) ||
    manifest.sourceFamilies.length < 2 ||
    manifest.sourceFamilies.length > 100
  )
    fail("MANIFEST_SCHEMA_OR_BLINDING_INVALID");
  if (input.excludedDevelopmentPublisherFamilies.length === 0)
    fail("MISSING_PRIOR_DEVELOPMENT_DENYLIST");
  const denied = new Set(input.excludedDevelopmentPublisherFamilies);
  if (
    denied.size !== input.excludedDevelopmentPublisherFamilies.length ||
    [...denied].some((x) => x !== x.trim().toLowerCase() || !x)
  )
    fail("BAD_EXTERNAL_FAMILY_DENYLIST");
  const publishers = new Set<string>(),
    repos = new Set<string>(),
    owners = new Set<string>(),
    sourceSnapshots = new Set<string>();
  for (const item of manifest.sourceFamilies as Record<string, unknown>[]) {
    const owner =
      obj(item) && typeof item.repository === "string"
        ? item.repository.split("/")[0]!.toLowerCase()
        : "";
    if (
      !obj(item) ||
      !keys(item, [
        "publisherFamily",
        "repository",
        "commitSha",
        "sourceSnapshotSha256",
        "sourceCount",
      ]) ||
      typeof item.publisherFamily !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{1,70}$/u.test(item.publisherFamily) ||
      publishers.has(item.publisherFamily) ||
      denied.has(item.publisherFamily) ||
      typeof item.repository !== "string" ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(item.repository) ||
      repos.has(item.repository.toLowerCase()) ||
      denied.has(owner) ||
      owners.has(owner) ||
      !rev.test(String(item.commitSha)) ||
      !hex.test(String(item.sourceSnapshotSha256)) ||
      sourceSnapshots.has(String(item.sourceSnapshotSha256)) ||
      !Number.isSafeInteger(item.sourceCount) ||
      Number(item.sourceCount) < 1
    )
      fail("SOURCE_FAMILIES_NOT_DISJOINT_OR_INVALID");
    publishers.add(item.publisherFamily as string);
    repos.add((item.repository as string).toLowerCase());
    owners.add(owner);
    sourceSnapshots.add(item.sourceSnapshotSha256 as string);
  }
  const languageCounts = manifest.languages as { en: number; es: number };
  return {
    schemaVersion: "akp.s2.holdout-freeze-audit.v1",
    status: "SIGNED_FAMILY_DISJOINT_FREEZE_STRUCTURALLY_VERIFIED",
    rawManifestSha256: input.precommittedManifestSha256,
    signatureVerified: true,
    trustedPublicKeyFingerprintMatched: true,
    familyDisjointFromExplicitDevelopmentList: true,
    familyCount: publishers.size,
    caseCount: manifest.caseCount as number,
    negativeCaseCount: manifest.negativeCaseCount as number,
    languages: {
      en: languageCounts.en,
      es: languageCounts.es,
    },
    independentReviewerIdentityAuthenticated: false,
    independentCustodianRoleExternallyAuthenticated: false,
    holdoutAdjudicationPerformed: false,
    releasedAnswerCorrectness: null,
    releasedFAR: null,
    gateAccepted: false,
  };
}
