import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore } from "../types";

export type S3Config = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** S3-compatible store: AWS S3, DigitalOcean Spaces, or MinIO. */
export function createS3ObjectStore(cfg: S3Config): ObjectStore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: Boolean(cfg.endpoint), // MinIO/Spaces need path style
  });

  return {
    async put(key, body, mimeType, opts) {
      // A stream has no intrinsic length and the SDK will not buffer it to find
      // one, so ContentLength must come from the caller (stat the file). Fail
      // loudly rather than let the SDK fall back to a silent full-body buffer.
      const contentLength = Buffer.isBuffer(body) ? body.byteLength : opts?.contentLength;
      if (contentLength === undefined) {
        throw new Error(`ObjectStore.put("${key}"): a streamed body requires opts.contentLength`);
      }
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
          ContentLength: contentLength,
        }),
      );
    },
    async getBuffer(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
    async getStream(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return { stream: res.Body as Readable, mimeType: res.ContentType, contentLength: res.ContentLength };
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    // Remotion Lambda renderers fetch assets directly from the (private) R2
    // bucket over presigned HTTPS — the documented pattern for private assets.
    async presignGet(key, ttlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
        expiresIn: ttlSec,
      });
    },
  };
}
