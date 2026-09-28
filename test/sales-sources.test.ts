import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readWbLedger, readWbFunnel } from "../src/modules/sales/sales-sync.service";
import { db, queue, redis } from "../src/infrastructure/clients";
after(async () => { await queue.close(); await redis.quit(); await db.$disconnect(); });
test("WB ledger paginates until empty and refuses stalled/incomplete sources", async () => {
  let calls = 0;
  const result = await readWbLedger(async () => ++calls === 1 ? [{ srid: "A", saleID: "S1", date: "2026-09-01T12:00:00", lastChangeDate: "2026-09-02T00:00:00", priceWithDisc: 123 }] : [], "sales", new Date("2026-09-01T00:00:00Z"));
  assert.equal(calls, 2); assert.equal(result[0].amount, 12300);
  await assert.rejects(() => readWbLedger(async () => ({ result: [] }), "orders", new Date()));
  calls = 0;
  await assert.rejects(() => readWbLedger(async () => { calls++; return [{ srid: "A", date: "2026-09-01T12:00:00", lastChangeDate: "2026-09-02T00:00:00" }]; }, "orders", new Date("2026-09-01T00:00:00Z")));
  assert.equal(calls, 2);
});
test("WB marketing funnel validates metrics without replacing missing values with zero", async () => {
  const response = { data: { products: [{ product: { nmId: 1, vendorCode: "A", title: "Quần" }, statistic: { selected: { openCount: 100, cartCount: 10, orderCount: 3, buyoutCount: 2 } } }] } };
  const data = await readWbFunnel(async (_h, _p, body: any) => { assert.deepEqual(body.selectedPeriod, { start: "2026-09-01", end: "2026-09-07" }); return response; }, "2026-09-01", "2026-09-07");
  assert.equal(data.products[0].current.views, 100);
  assert.equal(data.products[0].previous, null);
  await readWbFunnel(async (_h, _p, body: any) => {
    assert.deepEqual(body.pastPeriod, { start: "2026-08-01", end: "2026-08-07" });
    return response;
  }, "2026-09-01", "2026-09-07", "2026-08-01", "2026-08-07");
  await assert.rejects(() => readWbFunnel(async () => ({ data: { products: [{ product: { nmId: 1 }, statistic: { selected: {} } }] } }), "2026-09-01", "2026-09-07"));
});
