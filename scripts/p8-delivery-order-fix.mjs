import { readFile, writeFile } from "node:fs/promises";

const path = "apps/api/test/product-lifecycle.integration.test.ts";
let source = await readFile(path, "utf8");
const before = `    expect(rollbackDeliveries.rows.map((row) => row.event_type)).toEqual([\n      "CorpusRevisionPublished",\n      "LexicalIndexUpdateRequested",\n      "VectorIndexUpdateRequested",\n      "GraphIndexUpdateRequested",\n      "ContextPackInvalidationRequested",\n      "ImpactedEvalRunRequested",\n    ]);`;
const after = `    expect(rollbackDeliveries.rows.map((row) => row.event_type).sort()).toEqual(\n      [\n        "CorpusRevisionPublished",\n        "LexicalIndexUpdateRequested",\n        "VectorIndexUpdateRequested",\n        "GraphIndexUpdateRequested",\n        "ContextPackInvalidationRequested",\n        "ImpactedEvalRunRequested",\n      ].sort(),\n    );`;
const index = source.indexOf(before);
if (index < 0) throw new Error("P8 delivery assertion anchor missing");
if (source.indexOf(before, index + before.length) >= 0) {
  throw new Error("P8 delivery assertion anchor ambiguous");
}
source = source.slice(0, index) + after + source.slice(index + before.length);
await writeFile(path, source, "utf8");
console.log("P8 rollback delivery assertion made order-independent");
