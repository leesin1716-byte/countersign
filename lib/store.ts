// 워크스페이스(방문자별 데모 상태)와 호출 제한 카운터를 저장한다: 로컬은 JSON 파일, Vercel 은 비공개 Blob(인스턴스 간 공유)
import { promises as fs } from "node:fs";
import path from "node:path";
import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { Workspace } from "./types";

/** Serverless instances do not share memory or /tmp, so a hosted deployment keeps state in a private Vercel Blob store. */
export function storeBackend(): "blob" | "file" {
  return process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID ? "blob" : "file";
}

function dataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return process.env.VERCEL ? "/tmp/countersign" : path.join(process.cwd(), "data");
}

const memory = new Map<string, Workspace>();
const locks = new Map<string, Promise<unknown>>();
/** ETag of the blob each loaded workspace came from, so a stale copy cannot overwrite a newer one. */
const etags = new WeakMap<Workspace, string>();

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9-]/g, "");
const fileFor = (id: string) => path.join(dataDir(), `ws-${safeId(id)}.json`);
const blobFor = (id: string) => `countersign/ws-${safeId(id)}.json`;

async function readBlob(pathname: string): Promise<{ text: string; etag: string } | null> {
  const res = await get(pathname, { access: "private", useCache: false });
  if (!res || res.statusCode !== 200) return null;
  // Bodies over ~1 KB come back compressed with a weak ETag, W/"<hash>", for the same stored version.
  // put(ifMatch) only accepts the strong form, so drop the W/ marker; a real newer write still has a different hash.
  return { text: await new Response(res.stream).text(), etag: res.blob.etag.replace(/^W\//, "") };
}

async function writeBlob(pathname: string, text: string, ifMatch?: string): Promise<string> {
  const res = await put(pathname, text, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    ...(ifMatch ? { ifMatch } : {}),
  });
  return res.etag;
}

export async function loadWorkspace(id: string): Promise<Workspace | null> {
  if (storeBackend() === "blob") {
    const hit = await readBlob(blobFor(id));
    if (!hit) return null;
    const ws = JSON.parse(hit.text) as Workspace;
    etags.set(ws, hit.etag);
    return ws;
  }
  const hit = memory.get(id);
  if (hit) return hit;
  try {
    const ws = JSON.parse(await fs.readFile(fileFor(id), "utf8")) as Workspace;
    memory.set(id, ws);
    return ws;
  } catch {
    return null;
  }
}

export async function saveWorkspace(ws: Workspace): Promise<void> {
  if (storeBackend() === "blob") {
    try {
      etags.set(ws, await writeBlob(blobFor(ws.id), JSON.stringify(ws), etags.get(ws)));
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) throw new Error("This demo store was changed in another tab. Reload the page and try again.");
      throw e;
    }
    return;
  }
  memory.set(ws.id, ws);
  await fs.mkdir(dataDir(), { recursive: true });
  const target = fileFor(ws.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ws));
  // Windows can briefly lock a file that is being scanned or read; retry the atomic swap.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw e;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

/** Runs fn with exclusive access to one workspace (in-process). */
export async function withWorkspaceLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(id, run);
  try {
    return await run;
  } finally {
    if (locks.get(id) === run) locks.delete(id);
  }
}

export function forgetWorkspace(id: string): void {
  memory.delete(id);
}

/** Small JSON counters for rate limiting, persisted next to workspaces. */
export async function bumpCounter(name: string, limit: number, daily = true): Promise<{ ok: boolean; count: number }> {
  const suffix = daily ? `-${new Date().toISOString().slice(0, 10)}` : "";
  const base = `counter-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}${suffix}.json`;
  if (storeBackend() === "blob") return bumpBlobCounter(`countersign/${base}`, limit);
  const file = path.join(dataDir(), base);
  return withWorkspaceLock(`counter:${file}`, async () => {
    let count = 0;
    try {
      count = JSON.parse(await fs.readFile(file, "utf8")).count ?? 0;
    } catch {
      count = 0;
    }
    if (count >= limit) return { ok: false, count };
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ count: count + 1 }));
    return { ok: true, count: count + 1 };
  });
}

/** Compare-and-swap on the counter's ETag so concurrent instances cannot both spend the last call. */
async function bumpBlobCounter(pathname: string, limit: number): Promise<{ ok: boolean; count: number }> {
  return withWorkspaceLock(`counter:${pathname}`, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const hit = await readBlob(pathname);
      const count = hit ? (JSON.parse(hit.text).count ?? 0) : 0;
      if (count >= limit) return { ok: false, count };
      try {
        if (hit) {
          await writeBlob(pathname, JSON.stringify({ count: count + 1 }), hit.etag);
        } else {
          await put(pathname, JSON.stringify({ count: 1 }), { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 60 });
        }
        return { ok: true, count: count + 1 };
      } catch (e) {
        // Another instance wrote first (ETag moved, or the counter now exists); read again.
        await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
        if (attempt === 4) throw e;
      }
    }
    return { ok: false, count: limit };
  });
}
