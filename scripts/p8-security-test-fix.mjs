import { readFile, writeFile } from "node:fs/promises";

const path = "apps/extractor/tests/test_p5_chunkr_durability.py";
let source = await readFile(path, "utf8");
const importBefore =
  "from app.ports import DocumentExtractionRequest, DocumentIntelligenceError";
const importAfter =
  "from app.ports import (\n    CapabilityNotConfigured,\n    DocumentExtractionRequest,\n    DocumentIntelligenceError,\n)";
if (!source.includes(importBefore)) throw new Error("P8.1 Python import anchor missing");
source = source.replace(importBefore, importAfter);
const raisesBefore = 'with pytest.raises(Exception, match="not configured"):';
const raisesAfter =
  'with pytest.raises(CapabilityNotConfigured, match="not configured"):';
if (!source.includes(raisesBefore)) throw new Error("P8.1 SSRF assertion anchor missing");
source = source.replace(raisesBefore, raisesAfter);
await writeFile(path, source, "utf8");
console.log("P8.1 staged SSRF regression tightened");
