/**
 * S2 synthetic/development ONLY: Ollama native /api/chat structured outputs.
 * Never run on a sealed, newly approved holdout until new preregistration.
 * Default is freeze-only; explicit --execute-local runs local 127.0.0.1.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import path from "node:path";
import {
  freezeNativeStructuredWriter,
  observeNativeStructuredWriter,
} from "../packages/evaluation/src/s2-native-structured-writer.js";
import type {
  WriterProbeInput,
  FrozenOriginalReference,
} from "../packages/evaluation/src/s2-writer-passage-capture.js";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const argv = process.argv.slice(2);
const execute = argv.includes("--execute-local");
if ((!execute && argv.length !== 6) || (execute && argv.length !== 7))
  throw Error("S2_NATIVE_CLI_EXPECTED_SPEC_PIN_OUTPUT_OPTIONAL_EXECUTE");
const arg = (name: string) => {
  const i = argv.indexOf(name);
  if (
    i < 0 ||
    !argv[i + 1] ||
    argv[i + 1]!.startsWith("--") ||
    argv.filter((s) => s === name).length !== 1
  )
    throw Error("S2_NATIVE_CLI_MISSING_" + name);
  return path.resolve(argv[i + 1]!);
};
const specPath = arg("--spec"),
  pinPath = arg("--spec-pin-file"),
  out = arg("--output-dir");
const repo = path.resolve(import.meta.dirname, "..");
if (
  [specPath, pinPath, out].some(
    (p) => p === repo || p.startsWith(repo + path.sep),
  ) ||
  out === path.dirname(specPath) ||
  out === path.dirname(pinPath)
)
  throw Error("S2_NATIVE_CLI_REQUIRES_PRIVATE_FILES");
const [specBytes, pin] = await Promise.all([
  readFile(specPath),
  readFile(pinPath, "utf8"),
]);
if (!/^[a-f0-9]{64}\r?\n?$/u.test(pin) || sha(specBytes) !== pin.trim())
  throw Error("S2_NATIVE_CLI_SPEC_PIN_MISMATCH");
const spec = JSON.parse(
  new TextDecoder("utf8", { fatal: true }).decode(specBytes),
) as {
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
  spec.schemaVersion !== "akp.s2.writer-local-probe-spec.v1" ||
  !Array.isArray(spec.originals) ||
  spec.originals.length > 32
)
  throw Error("S2_NATIVE_CLI_INVALID_SPEC");
const originals: FrozenOriginalReference[] = await Promise.all(
  spec.originals.map(async (f) => ({
    documentKeySha256: f.documentKeySha256,
    fileSha256: f.fileSha256,
    fileBytes: await readFile(path.resolve(f.filePath)),
    bodyStartUtf16: f.bodyStartUtf16,
    bodyEndUtf16: f.bodyEndUtf16,
  })),
);
const frozen = freezeNativeStructuredWriter({
  case: spec.questionAndModel,
  originals,
  contextTokens: 8192,
  maxOutputTokens: 512,
});
await mkdir(out, { recursive: false });
const write = (name: string, b: Uint8Array) =>
  writeFile(path.join(out, name), b, { flag: "wx" });
const enc = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
await write("native-frozen-request.json", enc(frozen.freeze));
await write("native-exact-provider-request.utf8", frozen.requestBytes);
await write("source-spec-pin.sha256", Buffer.from(pin.trim() + "\n"));
if (!execute) {
  process.stdout.write(
    JSON.stringify({
      status: "NATIVE_WRITER_SCHEMA_REQUEST_FROZEN_NOT_SENT",
      requestSha256: frozen.freeze.exactRequestSha256,
      requestedContextTokens: frozen.freeze.requestedContextTokens,
      originalPassageCount: frozen.freeze.sourcePassages.length,
      modelCalled: false,
      gateAccepted: false,
    }) + "\n",
  );
} else {
  const tags = await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(15000),
  });
  if (!tags.ok) throw Error("S2_NATIVE_CLI_LOCAL_MODEL_UNAVAILABLE");
  const models = (await tags.json()) as {
    models?: { name: string; digest: string }[];
  };
  if (
    models.models?.find((m) => m.name === spec.questionAndModel.model)
      ?.digest !== spec.questionAndModel.modelDigestSha256
  )
    throw Error("S2_NATIVE_CLI_MODEL_DIGEST_MISMATCH");
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: frozen.requestBytes,
      signal: AbortSignal.timeout(150000),
    });
  } catch (e) {
    await write(
      "native-transport-failure.json",
      enc({
        requestSha256: frozen.freeze.exactRequestSha256,
        errorType: e instanceof Error ? e.name : "UNKNOWN",
        gateAccepted: false,
      }),
    );
    throw e;
  }
  const raw = new Uint8Array(await response.arrayBuffer());
  await write("native-exact-provider-response.utf8", raw);
  const observation = observeNativeStructuredWriter(
    frozen.freeze,
    frozen.requestBytes,
    raw,
  );
  await write(
    "native-observation.json",
    enc({
      ...observation,
      httpStatus: response.status,
      httpSucceeded: response.ok,
      providerOnlyMs: performance.now() - t0,
      localModelDigestVerified: true,
    }),
  );
  process.stdout.write(
    JSON.stringify({
      status: observation.status,
      reason: observation.reason,
      requestSha256: observation.requestSha256,
      responseSha256: observation.responseSha256,
      contextTokens: observation.requestedContextTokens,
      promptTokens: observation.promptTokens,
      completionTokens: observation.completionTokens,
      httpStatus: response.status,
      gateAccepted: false,
    }) + "\n",
  );
}
