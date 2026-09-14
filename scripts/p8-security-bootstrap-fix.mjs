import { readFile, writeFile } from "node:fs/promises";

const path = "scripts/p8-security-materialize.mjs";
let source = await readFile(path, "utf8");
const before =
  '      message: \\`Generated Markdown contains unsafe active markup: \\\\${unsafeMarkup}.\\`,\\n';
const after =
  '      message: "Generated Markdown contains unsafe active markup: " + unsafeMarkup + ".",\\n';
if (!source.includes(before)) {
  throw new Error("P8.1 unsafe markup interpolation anchor missing");
}
source = source.replace(before, after);
await writeFile(path, source, "utf8");
console.log("P8.1 security materializer interpolation repaired");
