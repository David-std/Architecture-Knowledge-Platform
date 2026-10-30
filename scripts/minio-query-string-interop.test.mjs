import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const minioRequire = createRequire(require.resolve("minio"));

test("patched legacy MinIO query-string uses fixed decoder without breaking CommonJS", () => {
  const minio = require("minio");
  assert.equal(typeof minio.Client, "function");
  const module = minioRequire("decode-uri-component");
  const decode = typeof module === "function" ? module : module.default;
  assert.equal(typeof decode, "function");
  const queryString = minioRequire("query-string");
  assert.deepEqual(
    Object.assign({}, queryString.parse("bucket=my-bucket&prefix=a%2Fb")),
    {
      bucket: "my-bucket",
      prefix: "a/b",
    },
  );
  assert.equal(queryString.parse("broken=%E0%A4%A").broken, "%E0%A4%A");
  assert.equal(
    queryString.stringify({ bucket: "my-bucket", prefix: "a/b" }),
    "bucket=my-bucket&prefix=a%2Fb",
  );
});
