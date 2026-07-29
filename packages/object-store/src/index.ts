import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

export interface RawObjectRef {
  bucket: string;
  key: string;
  sha256: string;
  bytes: number;
  mediaType?: string;
}

export interface ObjectStore {
  putImmutable(input: {
    stream: Readable;
    mediaType?: string;
    expectedSha256?: string;
  }): Promise<RawObjectRef>;
  get(ref: RawObjectRef): Promise<Readable>;
  exists(sha256: string): Promise<RawObjectRef | null>;
}

export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}
