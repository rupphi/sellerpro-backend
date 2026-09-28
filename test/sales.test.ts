import { test } from "node:test";
import assert from "node:assert/strict";
import { bounds, comparisonPeriod, funnelSourceKey, money, periodSchema, summarize, wbRows, ozonOrders } from "../src/modules/sales/sales.domain";

const wb = { srid: "order-1", date: "2026-09-01T01:00:00", warehouseType: "Склад WB", supplierArticle: "A", nmId: 123, totalPrice: 2000, discountPercent: 10, priceWithDisc: 1800 };
test("comparison dates keep equal durations, cross months, and isolate cached funnels", () => {
  const base = { from: "2026-09-01", to: "2026-09-07" };
  const automatic = comparisonPeriod(base);
  assert.equal(automatic.compareFrom, "2026-08-25");
  assert.equal(automatic.compareTo, "2026-08-31");
  const custom = periodSchema.parse({ ...base, compareFrom: "2026-08-01", compareTo: "2026-08-07" });
  assert.equal(comparisonPeriod(custom).comparisonEnd.toISOString(), "2026-08-07T21:00:00.000Z");
  assert.notEqual(funnelSourceKey(custom), funnelSourceKey(base));
  assert.equal(funnelSourceKey({ ...base, ...automatic }), funnelSourceKey(base));
  for (const comparison of [ { compareFrom: "2026-08-01" }, { compareFrom: "2026-08-01", compareTo: "2026-08-08" }, { compareFrom: base.from, compareTo: base.to } ]) {
    assert.equal(periodSchema.safeParse({ ...base, ...comparison }).success, false);
  }
});
test("sales periods validate calendar dates and Moscow midnight", () => {
  assert.equal(periodSchema.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success, false);
  assert.equal(periodSchema.safeParse({ from: "2026-01-01", to: "2026-03-01" }).success, false);
  assert.equal(periodSchema.safeParse({ from: "2026-09-02", to: "2026-09-01" }).success, false);
  const b = bounds("2026-09-01", "2026-09-07");
  assert.equal(b.start.toISOString(), "2026-08-31T21:00:00.000Z");
  assert.equal(b.end.toISOString(), "2026-09-07T21:00:00.000Z");
  assert.equal(b.previous.toISOString(), "2026-08-24T21:00:00.000Z");
});
test("WB maps warehouse explicitly, treats zero money as pending, separates return event", () => {
  const [order] = wbRows([wb], "order");
  assert.equal(order.amount, 180000);
  assert.equal(order.channel, "fbo");
  const [returned] = wbRows([{ ...wb, saleID: "R123", priceWithDisc: -1800 }], "transaction");
  assert.equal(returned.kind, "return");
  assert.equal(returned.amount, 180000);
  assert.equal(money(0), null);
  assert.equal(money("12.34"), 1234);
  assert.equal(wbRows([{ ...wb, warehouseType: "unknown", isSupply: true }], "order")[0].channel, "unknown");
  assert.throws(() => wbRows([{ ...wb, saleID: "OTHER" }], "transaction"));
});
test("event revenue and cohort outcomes cannot be mixed; returns subtracted once", () => {
  const order = wbRows([wb], "order");
  const sale = wbRows([{ ...wb, saleID: "S123", date: "2026-09-02T01:00:00" }], "transaction");
  const returned = wbRows([{ ...wb, saleID: "R123", date: "2026-09-10T01:00:00", priceWithDisc: -1800 }], "transaction");
  const b = bounds("2026-09-01", "2026-09-07");
  const result = summarize([...order, ...sale, ...returned], b.start, b.end);
  assert.equal(result.orders, 1);
  assert.equal(result.sales.value, 180000);
  assert.equal(result.returns.value, 0); // Return happened in a later period.
  assert.equal(result.cohort.returned, 1); // Same cohort now has a known return.
  const next = bounds("2026-09-10", "2026-09-10");
  const net = summarize([...order, ...sale, ...returned], next.start, next.end);
  assert.equal(net.orders, 0);
  assert.equal(net.netRevenue, -180000);
  const pending = summarize(wbRows([{ ...wb, saleID: "S1", priceWithDisc: 0 }], "transaction"), b.start, b.end);
  assert.equal(pending.netRevenue, null);
  assert.equal(pending.sales.missing, 1);
});
test("Ozon normalization counts a multi-item posting once and keeps units/amount separate", () => {
  const rows = ozonOrders([{ posting_number: "P1", in_process_at: "2026-09-01T00:00:00Z", status: "delivered", products: [
    { sku: 1, quantity: 2, price: "100.25", offer_id: "A" }, { sku: 2, quantity: 1, price: "300", offer_id: "B" },
  ] }], "fbs");
  const b = bounds("2026-09-01", "2026-09-01"), s = summarize(rows, b.start, b.end);
  assert.equal(s.orders, 1); assert.equal(s.units, 3); assert.equal(s.orderedValue, 50050);
  assert.equal(s.sales.count, 0); // Delivered posting must NOT fabricate a sale date or revenue event.
});
