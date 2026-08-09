import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Client } from "minio";

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

export async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

export interface MinioObjectStoreOptions {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export class MinioObjectStore implements ObjectStore {
  private readonly client: Client;
  private readonly bucket: string;

  constructor(options: MinioObjectStoreOptions) {
    const endpoint = new URL(options.endpoint);
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: Number(
        endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
      ),
      useSSL: endpoint.protocol === "https:",
      accessKey: options.accessKey,
      secretKey: options.secretKey,
    });
    this.bucket = options.bucket;
  }

  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) {
      await this.client.makeBucket(this.bucket);
    }
  }

  async putImmutable(input: {
    stream: Readable;
    mediaType?: string;
    expectedSha256?: string;
  }): Promise<RawObjectRef> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maximumBytes = Number(
      process.env.AKP_MAX_SOURCE_BYTES ?? 512 * 1024 * 1024,
    );
    for await (const chunk of input.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximumBytes)
        throw new Error(`Source exceeds ${maximumBytes} bytes.`);
      chunks.push(buffer);
    }
    const contents = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      throw new Error(
        `Source hash mismatch: expected ${input.expectedSha256}, received ${sha256}.`,
      );
    }
    await this.ensureBucket();
    const key = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    const existing = await this.exists(sha256);
    if (!existing) {
      await this.client.putObject(this.bucket, key, contents, contents.length, {
        "Content-Type": input.mediaType ?? "application/octet-stream",
        "X-Amz-Meta-Sha256": sha256,
      });
    }
    return {
      bucket: this.bucket,
      key,
      sha256,
      bytes,
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    };
  }

  async get(ref: RawObjectRef): Promise<Readable> {
    return this.client.getObject(ref.bucket, ref.key);
  }

  async exists(sha256: string): Promise<RawObjectRef | null> {
    const key = `sha256/${sha256.slice(0, 2)}/${sha256}`;
    try {
      const metadata = await this.client.statObject(this.bucket, key);
      return {
        bucket: this.bucket,
        key,
        sha256,
        bytes: metadata.size,
        ...(metadata.metaData?.["content-type"]
          ? { mediaType: String(metadata.metaData["content-type"]) }
          : {}),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code === "NoSuchKey" ||
        code === "NotFound" ||
        code === "NoSuchBucket"
      )
        return null;
      throw error;
    }
  }
}
