import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_EXPORT_CONFIRMATION,
  AuditExportClientError,
  RAW_EVIDENCE_EXPORT_CONFIRMATION,
  requestAuditExport,
  requestRawEvidenceExport,
  resolveAuditExportPath,
} from "../src/audit-export.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("audit export client", () => {
  it("writes only under an explicit export root and sends confirmation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-audit-cli-"));
    roots.push(root);
    let requestedUrl = "";
    const outputPath = path.join(root, "review", "bundle.zip");
    const result = await requestAuditExport({
      apiBase: "http://127.0.0.1:8080",
      token: "test-token",
      vaultId: "11111111-1111-4111-8111-111111111111",
      confirmation: AUDIT_EXPORT_CONFIRMATION,
      outputPath,
      exportRoots: [root],
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(new Uint8Array([0x50, 0x4b]), {
          status: 200,
          headers: {
            "x-akp-bundle-hash": "a".repeat(64),
            "x-akp-bundle-schema-version": "1.0",
          },
        });
      },
    });

    expect(requestedUrl).toContain(`confirm=${AUDIT_EXPORT_CONFIRMATION}`);
    expect(result).toMatchObject({
      status: "EXPORTED",
      schemaVersion: "1.0",
      bundleHash: "a".repeat(64),
      path: outputPath,
    });
    expect(await readFile(outputPath)).toEqual(Buffer.from([0x50, 0x4b]));
  });

  it("rejects an output outside the configured roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-audit-cli-"));
    roots.push(root);
    await expect(
      resolveAuditExportPath(path.resolve(root, "..", "escaped.zip"), [root]),
    ).rejects.toMatchObject<Partial<AuditExportClientError>>({
      code: "EXPORT_PATH_DENIED",
    });
  });

  it("requires the exact explicit confirmation before making a request", async () => {
    await expect(
      requestAuditExport({
        apiBase: "http://127.0.0.1:8080",
        token: "test-token",
        vaultId: "11111111-1111-4111-8111-111111111111",
        confirmation: "NO",
        fetchImpl: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toMatchObject<Partial<AuditExportClientError>>({
      code: "EXPORT_CONFIRMATION_REQUIRED",
    });
  });

  it("exports raw evidence only with its separate confirmation and selector", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-raw-cli-"));
    roots.push(root);
    let requestedUrl = "";
    const outputPath = path.join(root, "evidence.bin");
    const result = await requestRawEvidenceExport({
      apiBase: "http://127.0.0.1:8080",
      token: "test-token",
      vaultId: "11111111-1111-4111-8111-111111111111",
      evidenceId: "22222222-2222-4222-8222-222222222222",
      confirmation: RAW_EVIDENCE_EXPORT_CONFIRMATION,
      outputPath,
      exportRoots: [root],
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "x-akp-evidence-sha256": "a".repeat(64),
            "x-akp-evidence-bytes": "3",
          },
        });
      },
    });
    expect(requestedUrl).toContain("/v1/evidence/export/");
    expect(requestedUrl).toContain("22222222-2222-4222-8222-222222222222");
    expect(requestedUrl).toContain(
      `confirm=${RAW_EVIDENCE_EXPORT_CONFIRMATION}`,
    );
    expect(result).toMatchObject({
      status: "EXPORTED",
      bytes: 3,
      path: outputPath,
      sha256: "a".repeat(64),
    });
    expect(await readFile(outputPath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("rejects raw export without an explicit selector or confirmation", async () => {
    await expect(
      requestRawEvidenceExport({
        apiBase: "http://127.0.0.1:8080",
        token: "test-token",
        vaultId: "11111111-1111-4111-8111-111111111111",
        confirmation: RAW_EVIDENCE_EXPORT_CONFIRMATION,
        fetchImpl: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toMatchObject<Partial<AuditExportClientError>>({
      code: "EVIDENCE_SELECTOR_REQUIRED",
    });
    await expect(
      requestRawEvidenceExport({
        apiBase: "http://127.0.0.1:8080",
        token: "test-token",
        vaultId: "11111111-1111-4111-8111-111111111111",
        evidenceId: "22222222-2222-4222-8222-222222222222",
        confirmation: AUDIT_EXPORT_CONFIRMATION,
        fetchImpl: async () => new Response(null, { status: 200 }),
      }),
    ).rejects.toMatchObject<Partial<AuditExportClientError>>({
      code: "RAW_EVIDENCE_CONFIRMATION_REQUIRED",
    });
  });
});
