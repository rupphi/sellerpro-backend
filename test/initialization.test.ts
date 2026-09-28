import { test } from "node:test";
import assert from "node:assert/strict";
import { runInitialization } from "../src/modules/automation/initialization.runner";
import { defaultSalesPeriod } from "../src/modules/automation/automation.policy";
test("initialization runs catalog, pricing with discounts, guard then sales; catalog failure stops chain", async () => {
  const calls: string[] = [];
  const deps = {
    catalog: async () => { calls.push("catalog"); },
    pricing: async () => { calls.push("pricing"); return "ready"; },
    guard: async () => { calls.push("guard"); return { errors: [] }; },
    sales: async (period: unknown) => { calls.push("sales"); assert.deepEqual(period, defaultSalesPeriod(new Date("2026-09-28T00:30:00Z"))); return { errors: [] }; },
  };
  const input = { initialization: ["catalog", "pricing", "sales"], initializationGuard: true };
  const result = await runInitialization(input, "wb", deps, async () => {}, new Date("2026-09-28T00:30:00Z"));
  assert.deepEqual(calls, ["catalog", "pricing", "guard", "sales"]);
  assert.deepEqual(result.steps.map(s => s.step), ["catalog", "pricing", "sales"]);
  calls.length = 0;
  await assert.rejects(() => runInitialization(input, "wb", { ...deps, catalog: async () => { throw new Error("catalog failed"); } }, async () => {}));
  assert.deepEqual(calls, []);
  const ozon = await runInitialization(input, "ozon", deps, async () => {});
  assert.equal(ozon.steps.at(-1)?.status, "unavailable");
  assert.equal(calls.includes("sales"), false);
  await assert.rejects(() => runInitialization({ initialization: ["catalog", "finance"] }, "wb", deps, async () => {}));
});
