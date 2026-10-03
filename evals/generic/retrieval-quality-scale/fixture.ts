/**
 * Public, synthetic R8 fixture definitions.
 *
 * Gold targets are described by source text and structural expectations rather
 * than database IDs. The benchmark resolves them through the current Markdown
 * parser before any retrieval call, so a retriever cannot define its own gold.
 */

export type ScaleVaultKey = "gold" | "other-vault";

export type ScaleDocumentLifecycle = "ACTIVE" | "DISPUTED" | "SUPERSEDED";
export type ScaleRefreshStatus =
  "CURRENT" | "STALE_PENDING_REVIEW" | "STALE_BLOCKED";

export interface ScaleDocumentDefinition {
  key: string;
  vault: ScaleVaultKey;
  title: string;
  path: string;
  body: string;
  aliases?: readonly string[];
  lifecycle?: ScaleDocumentLifecycle;
  refreshStatus?: ScaleRefreshStatus;
  trustTier?: "MACHINE_SUPPORTED" | "HUMAN_REVIEWED";
}

export interface ScaleGoldTargetDefinition {
  document: string;
  /** Unit type emitted by parseKnowledgeUnits for the source block. */
  unitType: "PARAGRAPH" | "RULE" | "TABLE_ROW" | "TABLE_CELL" | "EVIDENCE";
  /** Distinguishes the gold block from sibling units in the same document. */
  bodyIncludes: string;
  /** Exact source bytes used to derive the independent UTF-16 span label. */
  spanText: string;
}

export interface ScaleCaseDefinition {
  id: string;
  slice:
    | "en"
    | "es"
    | "table"
    | "numeric"
    | "date"
    | "noanswer"
    | "contradiction"
    | "wrong-relation"
    | "same-title"
    | "near-duplicate"
    | "stale-version"
    | "close-number-date";
  query: string;
  vaults: readonly ScaleVaultKey[];
  gold: readonly ScaleGoldTargetDefinition[];
  expectNoAnswer?: boolean;
  critical?: boolean;
}

export interface ScaleFixtureDefinition {
  version: "r8-quality-scale-v1";
  vaults: readonly {
    key: ScaleVaultKey;
    name: string;
    canonicalPath: string;
  }[];
  documents: readonly ScaleDocumentDefinition[];
  cases: readonly ScaleCaseDefinition[];
}

/**
 * The corpus deliberately contains near duplicates, stale material, a second
 * vault with the same title, reversed relations, close numbers/dates and a
 * contradictory policy. Generated distractors are appended by the benchmark
 * and never alter these source labels.
 */
export const R8_QUALITY_SCALE_FIXTURE: ScaleFixtureDefinition = {
  version: "r8-quality-scale-v1",
  vaults: [
    {
      key: "gold",
      name: "R8 Gold Architecture Vault",
      canonicalPath: "benchmark/r8/gold",
    },
    {
      key: "other-vault",
      name: "R8 Other Architecture Vault",
      canonicalPath: "benchmark/r8/other-vault",
    },
  ],
  documents: [
    {
      key: "retention-current",
      vault: "gold",
      title: "Audit Retention Policy",
      path: "policies/audit-retention-current.md",
      body: [
        "# Current rule",
        "",
        "Production audit logs must be retained for 365 days from creation.",
      ].join("\n"),
      aliases: ["audit-log retention"],
    },
    {
      key: "retention-near-duplicate",
      vault: "gold",
      title: "Audit Retention Policy",
      path: "policies/audit-retention-near-duplicate.md",
      body: [
        "# Similar wording",
        "",
        "Production audit logs must be retained for 364 days from creation.",
      ].join("\n"),
      lifecycle: "ACTIVE",
    },
    {
      key: "retention-stale",
      vault: "gold",
      title: "Audit Retention Policy",
      path: "policies/audit-retention-stale.md",
      body: [
        "# Superseded rule",
        "",
        "Production audit logs must be retained for 90 days from creation.",
      ].join("\n"),
      lifecycle: "SUPERSEDED",
      refreshStatus: "STALE_BLOCKED",
    },
    {
      key: "retention-other-vault",
      vault: "other-vault",
      title: "Audit Retention Policy",
      path: "policies/audit-retention.md",
      body: [
        "# Other vault rule",
        "",
        "Audit logs in the research vault must be retained for 30 days.",
      ].join("\n"),
    },
    {
      key: "retry-es",
      vault: "gold",
      title: "Política de reintentos",
      path: "policies/reintentos.md",
      body: [
        "# Regla de reintentos",
        "",
        "Las llamadas transitorias se reintentan como máximo 3 veces con retroceso exponencial.",
      ].join("\n"),
      aliases: ["transient retry policy"],
    },
    {
      key: "timeout-table",
      vault: "gold",
      title: "Service timeout matrix",
      path: "policies/service-timeouts.md",
      body: [
        "# Request timeouts",
        "",
        "| Tier | Timeout |",
        "| --- | --- |",
        "| gold | 800 ms |",
        "| silver | 1200 ms |",
      ].join("\n"),
    },
    {
      key: "maintenance-current",
      vault: "gold",
      title: "Approved maintenance window",
      path: "operations/maintenance-window-current.md",
      body: [
        "# Approved window",
        "",
        "The approved maintenance window is 2026-11-15 at 02:00 UTC.",
      ].join("\n"),
    },
    {
      key: "maintenance-close-date",
      vault: "gold",
      title: "Approved maintenance window",
      path: "operations/maintenance-window-neighbor.md",
      body: [
        "# Neighboring window",
        "",
        "The approved maintenance window is 2026-11-16 at 02:00 UTC.",
      ].join("\n"),
    },
    {
      key: "sharing-current",
      vault: "gold",
      title: "Public data sharing policy",
      path: "policies/public-data-sharing-current.md",
      body: [
        "# Current rule",
        "",
        "Public data may be shared with external partners only after security approval.",
      ].join("\n"),
    },
    {
      key: "sharing-contradiction",
      vault: "gold",
      title: "Public data sharing policy",
      path: "policies/public-data-sharing-contradiction.md",
      body: [
        "# Contradictory draft",
        "",
        "Public data may be shared with external partners without security approval.",
      ].join("\n"),
      lifecycle: "DISPUTED",
      refreshStatus: "STALE_PENDING_REVIEW",
    },
    {
      key: "ingress-producer",
      vault: "gold",
      title: "Ingress boundary relation",
      path: "architecture/ingress-producer.md",
      body: [
        "# Producer relation",
        "",
        "The ingress validation service produces the boundary decision record.",
      ].join("\n"),
    },
    {
      key: "ingress-consumer",
      vault: "gold",
      title: "Ingress boundary relation",
      path: "architecture/ingress-consumer.md",
      body: [
        "# Reversed relation",
        "",
        "The ingress validation service consumes the boundary decision record.",
      ].join("\n"),
    },
  ],
  cases: [
    {
      id: "r8-en-retention-current",
      slice: "en",
      query: "How many days must production audit logs be retained?",
      vaults: ["gold"],
      gold: [
        {
          document: "retention-current",
          unitType: "RULE",
          bodyIncludes: "retained for 365 days",
          spanText:
            "Production audit logs must be retained for 365 days from creation.",
        },
      ],
      critical: true,
    },
    {
      id: "r8-es-retry-rule",
      slice: "es",
      query:
        "¿Cuántas veces se reintentan las llamadas transitorias y qué retroceso se usa?",
      vaults: ["gold"],
      gold: [
        {
          document: "retry-es",
          unitType: "RULE",
          bodyIncludes: "3 veces con retroceso exponencial",
          spanText:
            "Las llamadas transitorias se reintentan como máximo 3 veces con retroceso exponencial.",
        },
      ],
      critical: true,
    },
    {
      id: "r8-table-gold-timeout",
      slice: "table",
      query: "What timeout applies to the gold tier?",
      vaults: ["gold"],
      gold: [
        {
          document: "timeout-table",
          unitType: "TABLE_ROW",
          bodyIncludes: "gold | 800 ms",
          spanText: "| gold | 800 ms |",
        },
      ],
      critical: true,
    },
    {
      id: "r8-date-current-window",
      slice: "date",
      query: "Which date is the approved maintenance window on 2026-11-15?",
      vaults: ["gold"],
      gold: [
        {
          document: "maintenance-current",
          unitType: "PARAGRAPH",
          bodyIncludes: "2026-11-15",
          spanText:
            "The approved maintenance window is 2026-11-15 at 02:00 UTC.",
        },
      ],
    },
    {
      id: "r8-number-sharing-approval",
      slice: "numeric",
      query: "What approval is required before public data sharing?",
      vaults: ["gold"],
      gold: [
        {
          document: "sharing-current",
          unitType: "RULE",
          bodyIncludes: "only after security approval",
          spanText:
            "Public data may be shared with external partners only after security approval.",
        },
      ],
      critical: true,
    },
    {
      id: "r8-wrong-relation-producer",
      slice: "wrong-relation",
      query: "Which service produces the boundary decision record?",
      vaults: ["gold"],
      gold: [
        {
          document: "ingress-producer",
          unitType: "PARAGRAPH",
          bodyIncludes: "produces the boundary decision record",
          spanText:
            "The ingress validation service produces the boundary decision record.",
        },
      ],
    },
    {
      id: "r8-same-title-cross-vault",
      slice: "same-title",
      query: "How many days must production audit logs be retained?",
      vaults: ["gold", "other-vault"],
      gold: [
        {
          document: "retention-current",
          unitType: "RULE",
          bodyIncludes: "retained for 365 days",
          spanText:
            "Production audit logs must be retained for 365 days from creation.",
        },
      ],
      critical: true,
    },
    {
      id: "r8-noanswer-encryption",
      slice: "noanswer",
      query: "What encryption mode is mandated for this benchmark corpus?",
      vaults: ["gold"],
      gold: [],
      expectNoAnswer: true,
    },
    {
      id: "r8-contradictory-sharing",
      slice: "contradiction",
      query: "What approval is required before public data sharing?",
      vaults: ["gold"],
      gold: [
        {
          document: "sharing-current",
          unitType: "RULE",
          bodyIncludes: "only after security approval",
          spanText:
            "Public data may be shared with external partners only after security approval.",
        },
      ],
      critical: true,
    },
    {
      id: "r8-stale-retention-adversary",
      slice: "stale-version",
      query: "How many days must production audit logs be retained?",
      vaults: ["gold"],
      gold: [
        {
          document: "retention-current",
          unitType: "RULE",
          bodyIncludes: "retained for 365 days",
          spanText:
            "Production audit logs must be retained for 365 days from creation.",
        },
      ],
    },
    {
      id: "r8-close-date-adversary",
      slice: "close-number-date",
      query: "Which date is the approved maintenance window on 2026-11-15?",
      vaults: ["gold"],
      gold: [
        {
          document: "maintenance-current",
          unitType: "PARAGRAPH",
          bodyIncludes: "2026-11-15",
          spanText:
            "The approved maintenance window is 2026-11-15 at 02:00 UTC.",
        },
      ],
    },
    {
      id: "r8-near-duplicate-adversary",
      slice: "near-duplicate",
      query: "How many days must production audit logs be retained?",
      vaults: ["gold"],
      gold: [
        {
          document: "retention-current",
          unitType: "RULE",
          bodyIncludes: "retained for 365 days",
          spanText:
            "Production audit logs must be retained for 365 days from creation.",
        },
      ],
    },
  ],
};
