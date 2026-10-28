import { afterEach, describe, expect, it, vi } from "vitest";
import { S2PinnedLocalOllamaWriter } from "../src/s2-local-atomic-provider.js";
const digest = "e".repeat(64),
  commit = "a".repeat(40);
const provider = () =>
  new S2PinnedLocalOllamaWriter({
    model: "qwen2.5:7b-instruct",
    modelDigestSha256: digest,
    codeCommitSha: commit,
  });
const req = Buffer.from(
  JSON.stringify({
    model: "qwen2.5:7b-instruct",
    stream: false,
    format: { type: "object" },
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("S2 local Ollama provider safety before sending SOURCE", () => {
  it.each([
    [
      {
        model: "../http://malicious",
        modelDigestSha256: digest,
        codeCommitSha: commit,
      },
      "UNSAFE_MODEL_NAME",
    ],
    [
      {
        model: "qwen2.5:7b-instruct",
        modelDigestSha256: "BAD",
        codeCommitSha: commit,
      },
      "DIGEST_REQUIRED",
    ],
    [
      {
        model: "qwen2.5:7b-instruct",
        modelDigestSha256: digest,
        codeCommitSha: "BAD",
      },
      "COMMIT_REQUIRED",
    ],
  ])("rejects unsafe or unpinned provider configuration", (cfg, code) => {
    expect(() => new S2PinnedLocalOllamaWriter(cfg)).toThrow(code);
  });
  it("refuses stale model digest BEFORE sending any source to /api/chat", async () => {
    const mock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                name: "qwen2.5:7b-instruct",
                digest: "f".repeat(64),
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", mock);
    await expect(provider().generate(req)).rejects.toThrow(
      "MODEL_DIGEST_MISMATCH",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11434/api/tags");
  });
  it("sends frozen bytes unchanged to loopback only after model pin", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "qwen2.5:7b-instruct",
                digest,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('{"done":true}', { status: 200 }));
    vi.stubGlobal("fetch", mock);
    const raw = await provider().generate(req);
    expect(new TextDecoder().decode(raw)).toBe('{"done":true}');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:11434/api/chat");
    const init = mock.mock.calls[1]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(Buffer.from(init.body as Uint8Array)).toEqual(req);
    expect(init.method).toBe("POST");
  });
  it("refuses a forged model in a sent body before any I/O", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    await expect(
      provider().generate(
        Buffer.from(
          JSON.stringify({
            model: "other:latest",
          }),
        ),
      ),
    ).rejects.toThrow("MODEL_MISMATCH");
    expect(mock).not.toHaveBeenCalled();
  });
  it("rejects oversized untrusted provider bytes", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              {
                name: "qwen2.5:7b-instruct",
                digest,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("A".repeat(263000), { status: 200 }));
    vi.stubGlobal("fetch", mock);
    await expect(provider().generate(req)).rejects.toThrow(
      "RESPONSE_TOO_LARGE",
    );
  });
});
