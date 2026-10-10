// 시드 메시지 6통을 실제 Claude Haiku 로 한 번 돌려 결과를 lib/agent/seed-cache.json 에 저장한다(방문자마다 호출하지 않기 위한 비용 방어)
// Run: npx vitest run --config vitest.record.config.mts   (ONLY=late-gift,refund-now to limit; RECORD_PAYPAL=mock to skip the sandbox)
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";
import { anthropicClient } from "../lib/agent";
import { runAgent, toInput } from "../lib/agent/agent";
import { getPayPal } from "../lib/paypal";
import { provision, seedData } from "../lib/seed";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = line.indexOf("=");
  if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim();
}

test("record seed cache", async () => {
  const paypal = getPayPal(process.env.RECORD_PAYPAL === "mock" ? "mock" : "sandbox");
  const ws = seedData(`rec${Date.now().toString(36)}`, paypal.mode);
  await provision(ws, paypal);
  const only = process.env.ONLY?.split(",");
  const file = "lib/agent/seed-cache.json";
  const cache = JSON.parse(readFileSync(file, "utf8"));
  let input = 0;
  let output = 0;
  for (const m of ws.messages) {
    if (!m.seedKey || (only && !only.includes(m.seedKey))) continue;
    const run = await runAgent({ ws, message: m, paypal, llm: anthropicClient() });
    input += run.usage.input;
    output += run.usage.output;
    cache[m.seedKey] = {
      model: run.model,
      recordedAt: new Date().toISOString(),
      paypal: paypal.mode,
      proposal: toInput(run.proposal),
      calls: run.trace.filter((t) => t.tool !== "submit_proposal").map((t) => ({ tool: t.tool, input: t.input })),
    };
    console.log(`${m.seedKey}: ${run.proposal.action} ${run.proposal.refundAmount ?? ""} flags=${run.proposal.riskFlags.join("|")} tools=${run.trace.map((t) => t.tool).join(">")} tokens=${run.usage.input}+${run.usage.output}`);
    writeFileSync(file, JSON.stringify(cache, null, 2) + "\n");
  }
  console.log(`total tokens ${input} in / ${output} out, about $${((input * 1 + output * 5) / 1e6).toFixed(4)} at Haiku 4.5 prices`);
}, 600_000);
