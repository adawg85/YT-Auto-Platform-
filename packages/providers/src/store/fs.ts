import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { ObjectStore } from "../types";

/** Local-filesystem ObjectStore for dev/CI (no MinIO/S3 required). */
export function createFsObjectStore(baseDir: string): ObjectStore {
  function resolve(key: string): string {
    const path = normalize(join(baseDir, key));
    if (!path.startsWith(normalize(baseDir) + sep)) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return path;
  }

  return {
    async put(key, body) {
      const path = resolve(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async getBuffer(key) {
      return readFile(resolve(key));
    },
    async getStream(key) {
      const path = resolve(key);
      const info = await stat(path); // throw early if missing
      return { stream: createReadStream(path), contentLength: info.size };
    },
    async exists(key) {
      try {
        await access(resolve(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}
