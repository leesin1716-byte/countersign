// Vercel Blob 저장 경로(인스턴스 간 공유 상태)를 메모리 가짜 Blob 으로 검증한다: 왕복, 낡은 사본 덮어쓰기 차단, 카운터 한도·경합
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const blobs = new Map<string, { text: string; etag: string }>();
let version = 0;
let raceOnce: (() => void) | null = null;

vi.mock("@vercel/blob", () => {
  class BlobPreconditionFailedError extends Error {}
  return {
    BlobPreconditionFailedError,
    get: vi.fn(async (pathname: string) => {
      const b = blobs.get(pathname);
      if (!b) return null;
      return { statusCode: 200, stream: new Response(b.text).body, headers: new Headers(), blob: { etag: b.etag } };
    }),
    put: vi.fn(async (pathname: string, body: string, opts: { allowOverwrite?: boolean; ifMatch?: string }) => {
      if (raceOnce) {
        const r = raceOnce;
        raceOnce = null;
        r();
      }
      const cur = blobs.get(pathname);
      if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new BlobPreconditionFailedError("etag mismatch");
      if (cur && !opts.allowOverwrite && !opts.ifMatch) throw new Error("blob already exists");
      const etag = `"v${++version}"`;
      blobs.set(pathname, { text: body, etag });
      return { etag };
    }),
  };
});

const { bumpCounter, loadWorkspace, saveWorkspace, storeBackend } = await import("../lib/store");
const { seedData } = await import("../lib/seed");

beforeAll(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_fake";
});
afterAll(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
});
beforeEach(() => {
  blobs.clear();
  raceOnce = null;
});

describe("store on Vercel Blob", () => {
  it("uses the blob backend when a token is set", () => {
    expect(storeBackend()).toBe("blob");
  });

  it("round-trips a workspace through the blob store, not process memory", async () => {
    const ws = seedData("aaaabbbbccccdddd", "mock");
    await saveWorkspace(ws);
    const loaded = await loadWorkspace(ws.id);
    expect(loaded).not.toBe(ws);
    expect(loaded?.id).toBe(ws.id);
    expect(loaded?.messages.length).toBe(ws.messages.length);
    expect(await loadWorkspace("ffffffffffffffff")).toBeNull();
  });

  it("refuses to overwrite a newer copy written by another instance", async () => {
    await saveWorkspace(seedData("1111222233334444", "mock"));
    const a = (await loadWorkspace("1111222233334444"))!;
    const b = (await loadWorkspace("1111222233334444"))!;
    b.mandate.autoRefundMaxUsd = 2;
    await saveWorkspace(b);
    a.mandate.autoRefundMaxUsd = 99;
    await expect(saveWorkspace(a)).rejects.toThrow(/changed in another tab/);
    expect((await loadWorkspace("1111222233334444"))!.mandate.autoRefundMaxUsd).toBe(2);
  });

  it("counts up to the limit and then refuses", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await bumpCounter("ai-ip-test", 3));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3].count).toBe(3);
  });

  it("retries when another instance bumps the same counter first", async () => {
    await bumpCounter("ai-global", 5);
    const day = new Date().toISOString().slice(0, 10);
    const key = `countersign/counter-ai-global-${day}.json`;
    // Simulate a second instance writing between our read and our write.
    raceOnce = () => blobs.set(key, { text: JSON.stringify({ count: 4 }), etag: `"v${++version}"` });
    const r = await bumpCounter("ai-global", 5);
    expect(r).toEqual({ ok: true, count: 5 });
    expect((await bumpCounter("ai-global", 5)).ok).toBe(false);
  });
});
