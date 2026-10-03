import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectVault,
  parseWikiLinks,
  type VaultImportProfile,
} from "../src/index.js";

const temporaryRoots: string[] = [];

const legacyCurationProfile: VaultImportProfile = {
  rawPrefixes: ["Resources/transfer-packs", "00-system/governance"],
  sourceCollectionPrefix: "Resources/source-collection",
  transferPackPrefix: "Resources/transfer-packs",
  curatedRecoveryTypes: [
    "source-collection-guide",
    "source-collection-index",
    "source-recovery-map",
  ],
  rootRouterDocuments: [
    "README.md",
    "AGENTS.md",
    "PROJECT_STATE.md",
    "RESEARCH_LOG.md",
    "TRACEABILITY.md",
    "VALIDATION_REPORT.md",
    "CHANGELOG.md",
  ],
  layerMap: { Resources: "resource" },
  quarantineAcquisitionBacklogs: true,
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("parseWikiLinks", () => {
  it("imports regular Markdown files while skipping matching directories and hidden inputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-vault-traversal-"));
    temporaryRoots.push(root);
    for (const directory of [
      "folder.md",
      ".hidden",
      "nested/.hidden",
      "node_modules",
    ]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    for (const file of [
      "visible.md",
      "folder.md/note.md",
      ".hidden/note.md",
      "nested/.hidden/note.md",
      "node_modules/note.md",
    ]) {
      await writeFile(
        path.join(root, file),
        "# Source\nRead-only fixture.\n",
        "utf8",
      );
    }
    const result = await inspectVault(root);
    expect(result.documents.map((document) => document.relativePath)).toEqual([
      "folder.md/note.md",
      "visible.md",
    ]);
  });

  it("normalizes aliases, headings and extensions", () => {
    expect(
      parseWikiLinks(
        "See [[20-claims/claim-one.md|claim]], [[note#section]], and ![[image]].",
      ),
    ).toEqual(["20-claims/claim-one", "note", "image"]);
  });

  it("deduplicates targets", () => {
    expect(parseWikiLinks("[[same]] then [[same|again]]")).toEqual(["same"]);
  });
});

describe("title fallback and portable aliases", () => {
  it("uses the first Markdown heading as title and retains the file slug as an alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-title-fallback-"));
    temporaryRoots.push(root);
    await writeFile(
      path.join(root, "runtime-recovery-guide.md"),
      [
        "---",
        "id: TITLE-FALLBACK-001",
        "type: guide",
        "status: active",
        "---",
        "# Runtime Recovery",
        "",
        "Use the verified recovery path.",
      ].join("\n"),
      "utf8",
    );

    const inspection = await inspectVault(root);
    expect(inspection.documents[0]).toMatchObject({
      title: "Runtime Recovery",
      aliases: ["Runtime Recovery Guide"],
    });
  });

  it("preserves an explicit title without inventing a slug alias", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-title-explicit-"));
    temporaryRoots.push(root);
    await writeFile(
      path.join(root, "runtime-recovery-guide.md"),
      [
        "---",
        "id: TITLE-EXPLICIT-001",
        "type: guide",
        "status: active",
        "title: Canonical Recovery Title",
        "aliases: [Recovery Handbook]",
        "---",
        "# Different Heading",
        "",
        "Explicit metadata remains authoritative.",
      ].join("\n"),
      "utf8",
    );

    const inspection = await inspectVault(root);
    expect(inspection.documents[0]).toMatchObject({
      title: "Canonical Recovery Title",
      aliases: ["Recovery Handbook"],
    });
  });
});

describe("portable vault paths", () => {
  const document = (id: string): string =>
    [
      "---",
      `id: ${id}`,
      "type: rule",
      "status: active",
      "---",
      `# ${id}`,
      "",
      "Portable path fixture.",
    ].join("\n");

  it.skipIf(process.platform === "win32")(
    "rejects paths that collide on a case-insensitive filesystem",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "akp-path-case-"));
      temporaryRoots.push(root);
      await writeFile(path.join(root, "A.md"), document("PATH-UPPER"), "utf8");
      await writeFile(path.join(root, "a.md"), document("PATH-LOWER"), "utf8");

      await expect(inspectVault(root)).rejects.toThrow(
        /VAULT_PORTABLE_PATH_COLLISION/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects canonically equivalent Unicode paths",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "akp-path-unicode-"));
      temporaryRoots.push(root);
      await writeFile(
        path.join(root, "caf\u00e9.md"),
        document("PATH-NFC"),
        "utf8",
      );
      await writeFile(
        path.join(root, "cafe\u0301.md"),
        document("PATH-NFD"),
        "utf8",
      );

      await expect(inspectVault(root)).rejects.toThrow(
        /VAULT_PORTABLE_PATH_COLLISION/,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects Windows-reserved path segments before import",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "akp-path-reserved-"));
      temporaryRoots.push(root);
      await writeFile(path.join(root, "CON.md"), document("PATH-CON"), "utf8");

      await expect(inspectVault(root)).rejects.toThrow(
        /VAULT_NON_PORTABLE_PATH/,
      );
    },
  );
});

describe("agent-facing curation boundary", () => {
  it("promotes curated recovery maps but archives copied acquisition manifests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-vault-curation-"));
    temporaryRoots.push(root);
    const recoveryDirectory = path.join(
      root,
      "Resources",
      "source-collection",
      "01-Layered-Architecture",
    );
    const transferDirectory = path.join(
      root,
      "Resources",
      "transfer-packs",
      "legacy",
    );
    await mkdir(recoveryDirectory, { recursive: true });
    await mkdir(transferDirectory, { recursive: true });
    await writeFile(
      path.join(recoveryDirectory, "LINK.md"),
      [
        "---",
        "id: SRC-RECOVERY-LAYERED",
        "type: source-recovery-map",
        "status: curated",
        "---",
        "# Recuperación",
        "Start at [[SRC-LAYERED]].",
      ].join("\n"),
    );
    await mkdir(path.join(root, "10-sources", "evidence"), { recursive: true });
    await mkdir(path.join(root, "20-claims"), { recursive: true });
    await writeFile(
      path.join(root, "10-sources", "evidence", "evidence-layered.md"),
      [
        "---",
        "id: EVD-LAYERED",
        "type: evidence",
        "status: active",
        "---",
        "# Evidence",
        "A stable evidence fixture.",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "20-claims", "claim-layered.md"),
      [
        "---",
        "id: CLM-LAYERED",
        "type: claim",
        "status: active",
        "evidence: ['[[10-sources/evidence/evidence-layered]]']",
        "---",
        "# Claim",
        "A claim with an explicit evidence dependency.",
      ].join("\n"),
    );
    await writeFile(
      path.join(transferDirectory, "LINK.md"),
      [
        "---",
        "id: source-acquisition-manifest-v1",
        "type: source-manifest",
        "status: ready-for-acquisition",
        "---",
        "# Pending downloads",
        "| ☐ | CRITICAL | PAGO | ISO standard |",
        "Comprar una copia oficial.",
      ].join("\n"),
    );

    const inspection = await inspectVault(root, {
      profile: legacyCurationProfile,
    });
    const curated = inspection.documents.find(
      (document) => document.externalId === "SRC-RECOVERY-LAYERED",
    );
    const backlog = inspection.documents.find((document) =>
      document.relativePath.endsWith("transfer-packs/legacy/LINK.md"),
    );

    expect(curated).toMatchObject({
      operational: true,
      layer: "source",
      lifecycle: "ACTIVE",
      trustTier: "HUMAN_REVIEWED",
    });
    expect(backlog).toMatchObject({
      operational: false,
      type: "raw-transfer-artifact",
      lifecycle: "ARCHIVED",
      trustTier: "UNVERIFIED",
    });
    expect(backlog?.externalId).toMatch(/^RAW-[A-F0-9]{16}$/);
    expect(inspection.metrics.curatedRecoveryDocuments).toBe(1);
    expect(inspection.metrics.acquisitionBacklogsQuarantined).toBe(1);
    expect(inspection.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "CLM-LAYERED",
          to: "EVD-LAYERED",
          type: "derives_from",
        }),
      ]),
    );
    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ACQUISITION_BACKLOG_QUARANTINED" }),
      ]),
    );
  });

  it("does not apply one vault's folder names to a generic import", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-generic-vault-"));
    temporaryRoots.push(root);
    const resourceDirectory = path.join(root, "Resources", "notes");
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(
      path.join(resourceDirectory, "operational.md"),
      [
        "---",
        "id: GEN-RESOURCE-001",
        "type: handbook-note",
        "status: ready-for-acquisition",
        "---",
        "# Operational resource",
        "Comprar una copia oficial is merely quoted source text here.",
      ].join("\n"),
    );

    const inspection = await inspectVault(root);
    const document = inspection.documents.find(
      (entry) => entry.externalId === "GEN-RESOURCE-001",
    );

    expect(document).toMatchObject({
      operational: true,
      lifecycle: "ACTIVE",
      layer: "content",
      trustTier: "MACHINE_SUPPORTED",
    });
    expect(inspection.metrics.acquisitionBacklogsQuarantined).toBe(0);
  });
});
