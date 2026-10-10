// 워크스페이스(방문자별 데모 상태)를 JSON 파일로 저장하고 워크스페이스 단위로 직렬화해 갱신한다
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Workspace } from "./types";

function dataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return process.env.VERCEL ? "/tmp/countersign" : path.join(process.cwd(), "data");
}

const memory = new Map<string, Workspace>();
const locks = new Map<string, Promise<unknown>>();

const fileFor = (id: string) => path.join(dataDir(), `ws-${id.replace(/[^a-zA-Z0-9-]/g, "")}.json`);

export async function loadWorkspace(id: string): Promise<Workspace | null> {
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
  const file = path.join(dataDir(), `counter-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}${suffix}.json`);
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
