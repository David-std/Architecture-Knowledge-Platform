/**
 * Explicit opt-in local-only Ollama transport. Source bytes must already pass
 * current identity/revision/dual-review checks BEFORE calling generate().
 * No caller-supplied URL, model, token, prompt or redirect is accepted.
 */
export interface S2AtomicWriterProvider {
  readonly model: string;
  readonly modelDigestSha256: string;
  readonly codeCommitSha: string;
  readonly id: string;
  generate(requestBytes: Uint8Array): Promise<Uint8Array>;
}
const HEX = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MODEL = /^[a-zA-Z0-9_.:-]{1,100}$/u;
const assert = (ok: boolean, code: string) => {
  if (!ok) throw Error("S2_WRITER_PROVIDER_" + code);
};
async function capped(resp: Response, limit: number): Promise<Uint8Array> {
  assert(resp.ok, "HTTP_ERROR");
  if (Number(resp.headers.get("content-length") ?? 0) > limit)
    throw Error("S2_WRITER_PROVIDER_RESPONSE_TOO_LARGE");
  const reader = resp.body?.getReader();
  assert(!!reader, "EMPTY_PROVIDER_BODY");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const next = await reader!.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > limit) throw Error("S2_WRITER_PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
  } finally {
    reader?.releaseLock();
  }
  const merged = new Uint8Array(count);
  let i = 0;
  for (const chunk of chunks) {
    merged.set(chunk, i);
    i += chunk.byteLength;
  }
  return merged;
}
export class S2PinnedLocalOllamaWriter implements S2AtomicWriterProvider {
  readonly id = "s2:local-ollama-atomic-writer-v1";
  readonly model: string;
  readonly modelDigestSha256: string;
  readonly codeCommitSha: string;
  private readonly base = "http://127.0.0.1:11434";
  /** One resident model call at a time: reject concurrent GPU overload. */
  private inFlight = false;
  constructor(config: {
    model: string;
    modelDigestSha256: string;
    codeCommitSha: string;
  }) {
    assert(MODEL.test(config.model), "UNSAFE_MODEL_NAME");
    assert(HEX.test(config.modelDigestSha256), "DIGEST_REQUIRED");
    assert(COMMIT.test(config.codeCommitSha), "COMMIT_REQUIRED");
    this.model = config.model;
    this.modelDigestSha256 = config.modelDigestSha256;
    this.codeCommitSha = config.codeCommitSha;
  }
  async generate(requestBytes: Uint8Array): Promise<Uint8Array> {
    assert(!this.inFlight, "PROVIDER_BUSY");
    this.inFlight = true;
    try {
      assert(
        requestBytes.length > 0 && requestBytes.length <= 65536,
        "REQUEST_SIZE",
      );
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(requestBytes),
        );
      } catch {}
      assert(
        typeof parsed === "object" &&
          !!parsed &&
          !Array.isArray(parsed) &&
          (parsed as { model?: unknown }).model === this.model,
        "MODEL_MISMATCH",
      );
      // Pin before sending any protected SOURCE bytes. The local Ollama server
      // must advertise the expected immutable digest for the configured model.
      const signal = AbortSignal.timeout(18000);
      const tags = await fetch(this.base + "/api/tags", {
        signal,
        redirect: "error",
        cache: "no-store",
      });
      const bytes = await capped(tags, 65536);
      let registry: unknown = null;
      try {
        registry = JSON.parse(
          new TextDecoder("utf8", { fatal: true }).decode(bytes),
        );
      } catch {}
      const models =
        typeof registry === "object" &&
        registry !== null &&
        !Array.isArray(registry)
          ? (registry as { models?: unknown }).models
          : null;
      assert(
        Array.isArray(models) &&
          models.some(
            (m) =>
              typeof m === "object" &&
              m !== null &&
              (m as { name?: unknown }).name === this.model &&
              (m as { digest?: unknown }).digest === this.modelDigestSha256,
          ),
        "MODEL_DIGEST_MISMATCH",
      );
      const provider = await fetch(this.base + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(requestBytes),
        signal,
        redirect: "error",
      });
      return capped(provider, 262144);
    } finally {
      this.inFlight = false;
    }
  }
}
