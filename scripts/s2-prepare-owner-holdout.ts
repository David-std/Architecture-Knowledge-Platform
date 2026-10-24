/**
 * OWNER-CUSTODIED, NOT INSTITUTIONALLY INDEPENDENT.
 *
 * pnpm exec tsx scripts/s2-prepare-owner-holdout.ts
 *  --candidate-dir /private/candidate-source-frozen
 *  --owner-cases /private/owner-case-proposals.json
 *  --case-pin-file /private/owner-case-proposals.sha256
 *  --output-dir /private/new-exclusive-review-directory
 *
 * Owner gold labels are NEVER put into reviewer packets. No writer invoked.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { prepareOwnerHoldout } from "../packages/evaluation/src/s2-owner-holdout.js";
const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  if (
    i < 0 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((x) => x === name).length !== 1
  )
    throw Error("S2_OWNER_CLI_MISSING_" + name);
  return path.resolve(args[i + 1]!);
};
if (args.length !== 8) throw Error("S2_OWNER_CLI_NEED_FOUR_PATH_ARGUMENTS");
const candidateDir = arg("--candidate-dir");
const ownerCases = arg("--owner-cases");
const casePinFile = arg("--case-pin-file");
const outputDir = arg("--output-dir");
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const privatePaths = [candidateDir, ownerCases, casePinFile, outputDir];
if (
  privatePaths.some(
    (p) => p === repositoryRoot || p.startsWith(repositoryRoot + path.sep),
  )
)
  throw Error("S2_OWNER_CLI_PRIVATE_STORAGE_ONLY");
if (
  outputDir === candidateDir ||
  ownerCases.startsWith(outputDir + path.sep) ||
  casePinFile.startsWith(outputDir + path.sep)
)
  throw Error("S2_OWNER_CLI_OUTPUT_OVERLAPS_INPUT");
const originalManifestBytes = await readFile(
  path.join(candidateDir, "candidate-source-manifest.json"),
);
const sourcePin = (
  await readFile(
    path.join(candidateDir, "candidate-source-manifest.sha256"),
    "utf8",
  )
).trim();
const candidate = JSON.parse(originalManifestBytes.toString("utf8")) as {
  families: { files: { localRelativePath: string }[] }[];
};
if (!Array.isArray(candidate.families))
  throw Error("S2_OWNER_CLI_BAD_CANDIDATES");
const originals = [];
const seen = new Set<string>();
for (const family of candidate.families) {
  if (!Array.isArray(family.files)) throw Error("S2_OWNER_CLI_BAD_CANDIDATES");
  for (const f of family.files) {
    const name = f.localRelativePath;
    if (
      typeof name !== "string" ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((x) => !x || x === ".." || x === ".") ||
      seen.has(name)
    )
      throw Error("S2_OWNER_CLI_UNSAFE_SOURCE_RELATIVE_PATH");
    const target = path.resolve(candidateDir, ...name.split("/"));
    if (!target.startsWith(candidateDir + path.sep))
      throw Error("S2_OWNER_CLI_FILE_OUTSIDE_PRIVATE_DIR");
    seen.add(name);
    originals.push({
      localRelativePath: name,
      originalBytes: await readFile(target),
    });
  }
}
const [caseManifestBytes, casePinRaw] = await Promise.all([
  readFile(ownerCases),
  readFile(casePinFile, "utf8"),
]);
if (
  !/^[a-f0-9]{64}\r?\n?$/u.test(casePinRaw) ||
  !/^[a-f0-9]{64}$/u.test(sourcePin)
)
  throw Error("S2_OWNER_CLI_BAD_PRECOMMIT_DIGEST");
const seed = randomBytes(32);
const prepared = prepareOwnerHoldout({
  candidateManifestBytes: originalManifestBytes,
  precommittedCandidateManifestSha256: sourcePin,
  caseManifestBytes,
  precommittedCaseManifestSha256: casePinRaw.trim(),
  sourceFiles: originals,
  privateShuffleSeed: seed,
});
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const json = (x: unknown) =>
  Buffer.from(JSON.stringify(x, null, 2) + "\n", "utf8");
await mkdir(outputDir, { recursive: false });
const write = async (name: string, bytes: Uint8Array) =>
  writeFile(path.join(outputDir, name), bytes, { flag: "wx" });
const receipts = [];
for (const [i, assignment] of (["X", "Y"] as const).entries()) {
  const packet = prepared.packets[i]!;
  const packetFile = `s2-owner-reviewer-${assignment.toLowerCase()}-packet.json`;
  const packetBytes = json(packet);
  await write(packetFile, packetBytes);
  const receiptHash = sha(packetBytes);
  receipts.push({
    assignment,
    packetFile,
    packetSha256: receiptHash,
    caseCount: packet.cases.length,
  });
  await write(
    `s2-owner-reviewer-${assignment.toLowerCase()}-empty.json`,
    json({
      schemaVersion: "akp.s2.owner-reviewer-submission.v1",
      reviewerAssignment: assignment,
      packetSha256: receiptHash,
      cases: packet.cases.map((c) => ({
        questionKeySha256: c.questionKeySha256,
        answerability: null,
        answerText: "",
        exactSourceQuotes: [],
        note: null,
      })),
      reviewerIndependenceSelfReported: false,
      externallyCredentialed: false,
    }),
  );
}
await write(
  "s2-owner-review-packet-receipt.json",
  json({
    schemaVersion: "akp.s2.owner-review-packets-receipt.v1",
    sourceManifestSha256: prepared.sourceManifestSha256,
    caseManifestSha256: prepared.caseManifestSha256,
    packets: receipts,
    ownerControlled: true,
    externalIndependenceCertified: false,
    evaluationsReceived: 0,
    gateAccepted: false,
  }),
);
await write(
  "s2-owner-private-shuffle-seed.hex",
  Buffer.from(seed.toString("hex") + "\n"),
);
process.stdout.write(
  JSON.stringify({
    status: prepared.status,
    sources: prepared.originalFiles,
    questions: prepared.questions,
    negative: prepared.unsupportedQuestions,
    languages: prepared.languages,
    reviewerPackets: receipts.length,
    sourceAndGoldNotVisibleToWriter: true,
    externallyCredentialed: false,
    gateAccepted: false,
  }) + "\n",
);
