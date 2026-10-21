/**
 * Fail-closed offline preflight for a custodian-signed holdout manifest.
 * The signature attests byte possession by the EXPECTED trust-anchor key,
 * not an independently authenticated role/identity.
 * Never supply the signer private key to this verifier.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyPrecommittedHoldoutFreeze } from "../packages/evaluation/src/s2-holdout-freeze.js";
const args = process.argv.slice(2);
function value(name: string) {
  const i = args.indexOf(name);
  if (
    i < 0 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((x) => x === name).length !== 1
  )
    throw Error("S2_HOLDOUT_INVALID_ARG_" + name);
  return path.resolve(args[i + 1]!);
}
if (args.length !== 16) throw Error("S2_HOLDOUT_EIGHT_ARGUMENTS_REQUIRED");
const manifest = value("--manifest"),
  pin = value("--pin-file"),
  signature = value("--signature"),
  pem = value("--public-key"),
  fingerprint = value("--fingerprint-file"),
  denylist = value("--development-denylist"),
  denylistPin = value("--denylist-pin-file"),
  out = value("--output");
const root = path.resolve(import.meta.dirname, "..");
if (
  [manifest, pin, signature, pem, fingerprint, denylist, denylistPin, out].some(
    (p) => p === root || p.startsWith(root + path.sep),
  )
)
  throw Error("S2_HOLDOUT_ALL_FILES_MUST_BE_PRIVATE");
const [
  manifestBytes,
  pinStr,
  signatureBytes,
  pemStr,
  keyFingerprint,
  denylistBytes,
  denylistPinStr,
] = await Promise.all([
  readFile(manifest),
  readFile(pin, "utf8"),
  readFile(signature),
  readFile(pem, "utf8"),
  readFile(fingerprint, "utf8"),
  readFile(denylist),
  readFile(denylistPin, "utf8"),
]);
const hex = /^[a-f0-9]{64}\r?\n?$/u;
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
if (
  !hex.test(pinStr) ||
  !hex.test(keyFingerprint) ||
  !hex.test(denylistPinStr) ||
  hash(denylistBytes) !== denylistPinStr.trim()
)
  throw Error("S2_HOLDOUT_SEPARATE_TRUST_ANCHORS_UNVERIFIED");
const deny = JSON.parse(denylistBytes.toString("utf8")) as {
  schemaVersion: string;
  publisherFamilies: string[];
};
if (
  deny.schemaVersion !== "akp.s2.preexcluded-development-families.v1" ||
  !Array.isArray(deny.publisherFamilies)
)
  throw Error("S2_HOLDOUT_DENYLIST_INVALID");
const report = verifyPrecommittedHoldoutFreeze({
  manifestBytes,
  precommittedManifestSha256: pinStr.trim(),
  signatureBytes,
  externalPublicKeyPem: pemStr,
  expectedKeyFingerprintSha256: keyFingerprint.trim(),
  excludedDevelopmentPublisherFamilies: deny.publisherFamilies,
});
await writeFile(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    status: report.status,
    sourceFamilies: report.familyCount,
    cases: report.caseCount,
    negativeCases: report.negativeCaseCount,
    reviewerIndependenceAuthenticated: false,
    gateAccepted: false,
  }) + "\n",
);
