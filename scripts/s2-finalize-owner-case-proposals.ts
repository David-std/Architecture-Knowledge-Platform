/**
 * Turn OWNER-APPROVED editable questions into an immutable manifest + digest.
 * Original Markdown bytes and literal quote locations are revalidated.
 *
 * pnpm exec tsx scripts/s2-finalize-owner-case-proposals.ts
 *  --candidate-dir /private/source-candidates
 *  --draft /private/owner-reviewed-case-draft.json
 *  --output-dir /private/new-case-freeze
 *
 * Never use a draft written after viewing the target writer's holdout outputs.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { prepareOwnerHoldout } from "../packages/evaluation/src/s2-owner-holdout.js";
const args = process.argv.slice(2);
const val = (f: string) => {
  const i = args.indexOf(f);
  if (
    i < 0 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((x) => x === f).length !== 1
  )
    throw Error("S2_OWNER_FINALIZE_INVALID_" + f);
  return path.resolve(args[i + 1]!);
};
if (args.length !== 6) throw Error("S2_OWNER_FINALIZE_EXPECTS_THREE_PATHS");
const candidateDir = val("--candidate-dir"),
  draftPath = val("--draft"),
  out = val("--output-dir");
const root = path.resolve(import.meta.dirname, "..");
if (
  [candidateDir, draftPath, out].some(
    (p) => p === root || p.startsWith(root + path.sep),
  ) ||
  out === candidateDir ||
  draftPath.startsWith(out + path.sep)
)
  throw Error("S2_OWNER_FINALIZE_PRIVATE_PATHS_ONLY");
const candidateBytes = await readFile(
  path.join(candidateDir, "candidate-source-manifest.json"),
);
const precommit = (
  await readFile(
    path.join(candidateDir, "candidate-source-manifest.sha256"),
    "utf8",
  )
).trim();
const sha = (v: Uint8Array | string) =>
  createHash("sha256").update(v).digest("hex");
if (!/^[a-f0-9]{64}$/u.test(precommit) || sha(candidateBytes) !== precommit)
  throw Error("S2_OWNER_FINALIZE_CANDIDATE_NOT_FROZEN");
const candidate = JSON.parse(candidateBytes.toString("utf8")) as {
  families: {
    publisherFamily: string;
    files: { relativePath: string; localRelativePath: string }[];
  }[];
};
const files = [];
const find = new Map<string, string>();
for (const family of candidate.families) {
  for (const item of family.files) {
    const relative = item.localRelativePath;
    if (
      relative.startsWith("/") ||
      relative.includes("\\") ||
      relative.split("/").some((x) => !x || x === "." || x === "..")
    )
      throw Error("S2_OWNER_FINALIZE_UNSAFE_SOURCE_PATH");
    const filepath = path.resolve(candidateDir, ...relative.split("/"));
    if (!filepath.startsWith(candidateDir + path.sep))
      throw Error("S2_OWNER_FINALIZE_OUTSIDE_SOURCE_DIR");
    const content = await readFile(filepath);
    files.push({ localRelativePath: relative, originalBytes: content });
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
    const key = family.publisherFamily + "|" + item.relativePath;
    if (find.has(key)) throw Error("S2_OWNER_FINALIZE_DUPLICATE_SOURCE");
    find.set(key, text);
  }
}
const draft = JSON.parse(await readFile(draftPath, "utf8")) as {
  schemaVersion: string;
  approvedByOwner: boolean;
  reviewedBeforeWriterExecution: boolean;
  entries: {
    language: "en" | "es";
    question: string;
    sourceFamily: string;
    relativePath: string;
    proposedDisposition: "EXPLICITLY_DECIDABLE" | "NOT_SUPPORTED";
    proposedAnswer: string;
    supportingText: string;
  }[];
};
if (
  draft.schemaVersion !== "akp.s2.owner-human-editable-case-draft.v1" ||
  draft.approvedByOwner !== true ||
  draft.reviewedBeforeWriterExecution !== true ||
  !Array.isArray(draft.entries) ||
  draft.entries.length < 8
)
  throw Error("S2_OWNER_FINALIZE_OWNER_APPROVAL_OR_SCOPE_MISSING");
const cases = draft.entries.map((e) => {
  if (
    !["en", "es"].includes(e.language) ||
    typeof e.question !== "string" ||
    !e.question.trim() ||
    typeof e.supportingText !== "string" ||
    typeof e.proposedAnswer !== "string" ||
    !["EXPLICITLY_DECIDABLE", "NOT_SUPPORTED"].includes(e.proposedDisposition)
  )
    throw Error("S2_OWNER_FINALIZE_CASE_DRAFT_INVALID");
  const raw = find.get(e.sourceFamily + "|" + e.relativePath);
  if (raw === undefined) throw Error("S2_OWNER_FINALIZE_UNFROZEN_SOURCE");
  let quotes: { startUtf16: number; endUtf16: number; quote: string }[] = [];
  if (e.proposedDisposition === "EXPLICITLY_DECIDABLE") {
    const start = raw.indexOf(e.supportingText);
    if (
      !e.supportingText.trim() ||
      start < 0 ||
      raw.lastIndexOf(e.supportingText) !== start
    )
      throw Error("S2_OWNER_FINALIZE_SUPPORT_QUOTE_NOT_UNIQUE_LITERAL");
    quotes = [
      {
        startUtf16: start,
        endUtf16: start + e.supportingText.length,
        quote: e.supportingText,
      },
    ];
  } else if (e.supportingText !== "" || e.proposedAnswer !== "") {
    throw Error("S2_OWNER_FINALIZE_NEGATIVE_WITH_POSITIVE_EVIDENCE");
  }
  return {
    questionKeySha256: sha(e.language + "\0" + e.question),
    language: e.language,
    question: e.question,
    sourceFamily: e.sourceFamily,
    relativePath: e.relativePath,
    proposedDisposition: e.proposedDisposition,
    proposedAnswer: e.proposedAnswer,
    proposedQuotes: quotes,
  };
});
const manifest = Buffer.from(
  JSON.stringify(
    {
      schemaVersion: "akp.s2.owner-case-proposals.v1",
      candidateManifestSha256: precommit,
      custodianMode: "OWNER_CONTROLLED",
      questionsCreatedBeforeModelExecution: true,
      writerOutputsInspectedBeforeFreeze: false,
      cases,
    },
    null,
    2,
  ) + "\n",
);
const pin = sha(manifest);
const checked = prepareOwnerHoldout({
  candidateManifestBytes: candidateBytes,
  precommittedCandidateManifestSha256: precommit,
  caseManifestBytes: manifest,
  precommittedCaseManifestSha256: pin,
  sourceFiles: files,
  privateShuffleSeed: randomBytes(32),
});
await mkdir(out, { recursive: false });
await writeFile(path.join(out, "owner-case-proposals.json"), manifest, {
  flag: "wx",
});
await writeFile(path.join(out, "owner-case-proposals.sha256"), pin + "\n", {
  flag: "wx",
});
await writeFile(
  path.join(out, "owner-case-freeze-receipt.json"),
  JSON.stringify(
    {
      schemaVersion: "akp.s2.owner-case-freeze-receipt.v1",
      caseManifestSha256: pin,
      sourceManifestSha256: precommit,
      cases: checked.questions,
      sourceFiles: checked.originalFiles,
      languages: checked.languages,
      negatives: checked.unsupportedQuestions,
      approvedByOwner: true,
      externalIndependenceAttested: false,
      casesNotYetEvaluated: true,
      gateAccepted: false,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    status: "OWNER_PROPOSALS_PRECOMMITTED_NOT_EVALUATED",
    cases: checked.questions,
    negatives: checked.unsupportedQuestions,
    languages: checked.languages,
    caseManifestSha256: pin,
    gateAccepted: false,
  }),
);
