/**
 * OFFLINE LOCAL S2 WRITER PROBE, never production admission.
 *
 * pnpm exec tsx scripts/s2-freeze-and-run-writer-probe.ts
 *   --spec /private/probe.json --spec-pin-file /private/probe.sha256
 *   --output-dir /private/unique-run [--execute-local]
 *
 * Without --execute-local: freeze the exact request only. The frozen payload
 * is identical to the eventual HTTP body. With --execute-local: send only to
 * 127.0.0.1:11434; never pass secrets or private source data to cloud APIs.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  freezeExactWriterRequest,
  sealExactWriterResponse,
  type WriterProbeInput,
  type FrozenOriginalReference,
} from "../packages/evaluation/src/s2-writer-passage-capture.js";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const argv = process.argv.slice(2);
function flag(s: string) {
  const idx = argv.indexOf(s);
  if (
    idx < 0 ||
    idx === argv.length - 1 ||
    argv[idx + 1]!.startsWith("--") ||
    argv.filter((x) => x === s).length !== 1
  )
    throw Error("S2_CAPTURE_INVALID_" + s);
  return path.resolve(argv[idx + 1]!);
}
const execute = argv.includes("--execute-local");
if ((!execute && argv.length !== 6) || (execute && argv.length !== 7))
  throw Error("S2_CAPTURE_EXPECTED_SPEC_PIN_OUTPUT_AND_OPTIONAL_EXECUTE_LOCAL");
const specFile = flag("--spec"),
  pinFile = flag("--spec-pin-file"),
  out = flag("--output-dir");
const repo = path.resolve(import.meta.dirname, "..");
if (
  [out, specFile, pinFile].some(
    (p) => p === repo || p.startsWith(repo + path.sep),
  ) ||
  out === path.dirname(specFile) ||
  out === path.dirname(pinFile)
)
  throw Error("S2_CAPTURE_PRIVATE_INPUT_OUTPUT_REQUIRED");
const [specBytes, pinRaw] = await Promise.all([
  readFile(specFile),
  readFile(pinFile, "utf8"),
]);
if (!/^[a-f0-9]{64}\r?\n?$/u.test(pinRaw) || hash(specBytes) !== pinRaw.trim())
  throw Error("S2_CAPTURE_SPEC_NOT_PRECOMMITTED");
const payload = JSON.parse(specBytes.toString("utf8")) as {
  schemaVersion: string;
  questionAndModel: WriterProbeInput;
  originals: {
    documentKeySha256: string;
    fileSha256: string;
    filePath: string;
    bodyStartUtf16: number;
    bodyEndUtf16: number;
  }[];
};
if (
  payload.schemaVersion !== "akp.s2.writer-local-probe-spec.v1" ||
  !Array.isArray(payload.originals) ||
  payload.originals.length > 32
)
  throw Error("S2_CAPTURE_INVALID_SPEC");
const originals: FrozenOriginalReference[] = await Promise.all(
  payload.originals.map(async (file) => ({
    documentKeySha256: file.documentKeySha256,
    fileSha256: file.fileSha256,
    fileBytes: await readFile(path.resolve(file.filePath)),
    bodyStartUtf16: file.bodyStartUtf16,
    bodyEndUtf16: file.bodyEndUtf16,
  })),
);
const frozen = freezeExactWriterRequest(payload.questionAndModel, originals);
await mkdir(out, { recursive: false });
const write = async (name: string, bytes: Uint8Array) =>
  writeFile(path.join(out, name), bytes, { flag: "wx" });
const enc = (x: unknown) => Buffer.from(JSON.stringify(x, null, 2) + "\n");
await write("frozen-request.json", enc(frozen.frozen));
await write("exact-provider-request.utf8.json", frozen.requestBodyBytes);
await write("spec-pin.sha256.txt", Buffer.from(pinRaw.trim() + "\n"));
if (!execute) {
  process.stdout.write(
    JSON.stringify({
      status: "EXACT_PROVIDER_REQUEST_FROZEN_NOT_SENT",
      requestSha256: frozen.frozen.requestBodySha256,
      passageCount: frozen.frozen.passages.length,
      originalLiteralCount: frozen.frozen.passages.filter(
        (p) => p.source === "ORIGINAL_LITERAL_MATCH",
      ).length,
      gateAccepted: false,
    }) + "\n",
  );
} else {
  const { questionAndModel } = payload;
  const tags = await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(15000),
  });
  if (!tags.ok) throw Error("S2_CAPTURE_MODEL_REGISTRY_NOT_AVAILABLE");
  const tagJson = (await tags.json()) as {
    models?: { name: string; digest: string }[];
  };
  const digest = tagJson.models?.find(
    (m) => m.name === questionAndModel.model,
  )?.digest;
  if (digest !== questionAndModel.modelDigestSha256)
    throw Error("S2_CAPTURE_MODEL_DIGEST_CHANGED");
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetch("http://127.0.0.1:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: frozen.requestBodyBytes,
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    await write(
      "request-failure.json",
      enc({
        status: "REQUEST_FAILED",
        errorType: error instanceof Error ? error.name : "UNKNOWN",
        requestSha256: frozen.frozen.requestBodySha256,
        gateAccepted: false,
      }),
    );
    throw error;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const elapsed = performance.now() - t0;
  // Even HTTP provider errors are preserved as raw bytes for diagnosis.
  await write("exact-provider-response.utf8.json", bytes);
  const seal = sealExactWriterResponse(
    frozen.frozen,
    frozen.requestBodyBytes,
    bytes,
    elapsed,
  );
  await write(
    "response-receipt.json",
    enc({
      ...seal,
      httpStatus: response.status,
      httpSucceeded: response.ok,
      fullRequestHttpLatency: false,
    }),
  );
  process.stdout.write(
    JSON.stringify({
      status: response.ok
        ? "EXACT_PROVIDER_BYTES_CAPTURED"
        : "PROVIDER_HTTP_ERROR_CAPTURED",
      requestSha256: frozen.frozen.requestBodySha256,
      responseSha256: seal.rawResponseSha256,
      allPassagesLiteralOriginalBound: seal.allPassagesLiteralOriginalBound,
      fullRequestHttpLatency: false,
      gateAccepted: false,
    }) + "\n",
  );
}
