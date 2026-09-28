import { test } from "node:test";
import assert from "node:assert/strict";
import { financeFields, financePeriod, financeTotals, kopecks, normalizeFinance, readFinanceReports } from "../src/modules/finance/finance.domain";
import { parseFinanceJson } from "../src/integrations/marketplaces/finance-json";
import { automationSchema, DEFAULT_AUTOMATION, latestSlot } from "../src/modules/automation/automation.policy";
import { runInitialization } from "../src/modules/automation/initialization.runner";

const raw = (id = "25017383020260814") => ({ reportId: id, dateFrom: "2026-08-14", dateTo: "2026-08-14", createDate: "2026-08-15", currency: "RUB", reportType: 1, ...Object.fromEntries(financeFields.map(k => [k, "0"])), retailAmountSum: "123.45", bankPaymentSum: "-1.23" });
test("financial money is exact; missing stays null; malformed values fail closed", () => {
  assert.equal(kopecks("123.45"), 12345);
  assert.equal(kopecks("-1.23"), -123);
  assert.equal(kopecks("0.1"), 10);
  assert.equal(kopecks(undefined), null);
  for (const value of [12.34, "", "1.234", "NaN", "90071992547409999"]) assert.throws(() => kopecks(value));
});
test("WB report IDs survive JSON roundtrip beyond safe integer range", () => {
  const parsed = parseFinanceJson('{"reportId":25017383020260815,"bankPaymentSum":"123.45"}') as any;
  assert.equal(parsed.reportId, "25017383020260815");
  assert.equal(normalizeFinance({ ...raw(), ...parsed }).id, "25017383020260815");
  assert.throws(() => normalizeFinance({ ...raw(), reportId: 25017383020260815 }));
});
test("finance totals separate currencies and never fill missing amount with zero", () => {
  const a = normalizeFinance(raw()), b = normalizeFinance({ ...raw("2"), currency: "USD", bankPaymentSum: null });
  const totals = financeTotals([a, a, b]);
  assert.equal(totals[0].amounts.retailAmountSum, 24690);
  assert.equal(totals[0].amounts.bankPaymentSum, -246);
  assert.equal(totals[1].amounts.bankPaymentSum, null);
  assert.deepEqual(financeTotals([]), []);
});
test("finance fetch completes pages, rejects duplicates/partial failures and excludes out-of-period reports", async () => {
  const inputs: any[] = [];
  const period = { from: "2026-08-01", to: "2026-08-31" };
  const data = await readFinanceReports(async body => { inputs.push(body); return inputs.length === 1 ? Array.from({ length: 1000 }, (_, i) => raw(String(i))) : null; }, period);
  assert.equal(data.reports.length, 1000);
  assert.equal(inputs[1].offset, 1000);
  assert.equal(inputs[0].period, "daily");
  assert.deepEqual(await readFinanceReports(async () => null, period), { reports: [], excluded: 0 });
  await assert.rejects(() => readFinanceReports(async () => [raw(), raw()], period));
  await assert.rejects(() => readFinanceReports(async body => (body as any).offset ? Promise.reject(new Error("network")) : Array.from({ length: 1000 }, (_, i) => raw(String(i))), period));
  const excluded = await readFinanceReports(async () => [{ ...raw(), dateFrom: "2026-07-31" }], period);
  assert.equal(excluded.excluded, 1);
  assert.equal(excluded.reports.length, 0);
});
test("financial dates validate real days, range and source availability", () => {
  for (const p of [{ from: "2026-02-30", to: "2026-03-01" }, { from: "2024-12-01", to: "2024-12-31" }, { from: "2026-01-01", to: "2026-03-01" }, { from: "2099-01-01", to: "2099-01-01" }]) assert.equal(financePeriod.safeParse(p).success, false);
});
test("hourly sales has 24 valid slots and coalesces delayed work", () => {
  const sales = { enabled: true, times: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`) };
  assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, sales }).success, true);
  assert.equal(latestSlot("Asia/Ho_Chi_Minh", sales.times, new Date("2026-09-28T06:14:00Z"))?.key, "2026-09-28T13:00");
});
test("financial initialization runs after catalog/pricing and skips unsupported Ozon", async () => {
  const calls: string[] = [];
  const deps = { catalog: async () => { calls.push("catalog"); }, pricing: async () => { calls.push("pricing"); return "ready"; }, guard: async () => ({ errors: [] }), sales: async () => ({ errors: [] }), finance: async () => { calls.push("finance"); return { errors: [] }; } };
  const input = { initialization: ["catalog", "pricing", "finance"] };
  assert.deepEqual((await runInitialization(input, "wb", deps, async () => {})).errors, []);
  assert.deepEqual(calls, ["catalog", "pricing", "finance"]);
  calls.length = 0;
  assert.equal((await runInitialization(input, "ozon", deps, async () => {})).steps.at(-1)?.status, "unavailable");
  assert.deepEqual(calls, ["catalog", "pricing"]);
});
