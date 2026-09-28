import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amount,
  fetchOzonSales,
  fetchWbSales,
  latest,
  ozonPostings,
  wbSales,
} from "../src/integrations/marketplaces/buyer-prices";
const now = new Date("2026-09-28T08:00:00Z");
test("WB keeps the latest real sale, excludes returns, and treats zero as pending", () => {
  const sale = {
    nmId: 1,
    date: "2026-09-27T12:00:00",
    saleID: "S1",
    spp: 0,
    finishedPrice: 123.45,
  };
  const rows = wbSales(
    [
      sale,
      { ...sale, saleID: "R1", date: "2026-09-28T10:00:00" },
      { ...sale, nmId: 2, date: "2026-01-01T00:00:00" },
    ],
    now,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value.customerPrice, 12345);
  assert.equal(rows[0].value.discountPercent, 0);
  assert.equal(rows[0].value.transactionAt, "2026-09-27T09:00:00.000Z");
  const pending = wbSales(
    [sale, { ...sale, date: "2026-09-28T09:00:00", finishedPrice: 0 }],
    now,
  )[0];
  assert.equal(pending.value.customerPrice, null);
  assert.equal(pending.value.discountPercent, null);
});
const posting = {
  status: "delivered",
  in_process_at: "2026-09-27T05:00:00Z",
  products: [{ sku: 123, offer_id: "sample", price: "2800" }],
  financial_data: {
    products: [
      { product_id: 999, customer_price: 1 },
      {
        product_id: 123,
        price: 2800,
        customer_price: 1382.86,
        currency_code: "RUB",
        customer_currency_code: "RUB",
        total_discount_percent: 20,
      },
    ],
  },
};
test("Ozon matches financial SKU, uses customer price, never total discount as platform subsidy", () => {
  const row = ozonPostings([posting], "ozon_fbs", now)[0];
  assert.equal(row.key, "sample");
  assert.equal(row.value.customerPrice, 138286);
  assert.equal(row.value.discountPercent, 50.61);
  assert.equal(row.value.discountKind, "price_difference");
  assert.equal(
    ozonPostings([{ ...posting, status: "cancelled" }], "ozon_fbs", now).length,
    0,
  );
});
test("Missing, mixed-currency and unknown buyer prices are not guessed from seller price", () => {
  for (const value of [null, undefined, "", true, 0, -1, "oops"])
    assert.equal(amount(value), null);
  const missing = ozonPostings(
    [{ ...posting, financial_data: { products: [] } }],
    "ozon_fbo",
    now,
  )[0];
  assert.equal(missing.value.customerPrice, null);
  const mixed = ozonPostings(
    [
      {
        ...posting,
        financial_data: {
          products: [
            {
              product_id: 123,
              price: 2800,
              customer_price: 3000,
              currency_code: "RUB",
              customer_currency_code: "KZT",
            },
          ],
        },
      },
    ],
    "ozon_fbs",
    now,
  )[0];
  assert.equal(mixed.value.customerPrice, 300000);
  assert.equal(mixed.value.discountPercent, null);
});
test("WB follows lastChangeDate cursor until empty and rejects a stalled cursor", async () => {
  const paths: string[] = [];
  const result = await fetchWbSales(async (_, path) => {
    paths.push(path);
    return paths.length === 1
      ? [
          {
            nmId: 1,
            saleID: "S1",
            date: "2026-09-27T12:00:00",
            lastChangeDate: "2026-09-28T07:00:00",
            spp: 30,
            finishedPrice: 100,
          },
        ]
      : [];
  }, now);
  assert.equal(result.rows.length, 1);
  assert.equal(paths.length, 2);
  assert.ok(paths[1].includes(encodeURIComponent("2026-09-28T07:00:00")));
  await assert.rejects(
    fetchWbSales(async () => [{ lastChangeDate: "2026-09-27T10:00:00" }], now),
    /stalled/,
  );
});
test("Ozon merges channels chronologically; partial access is explicitly marked", async () => {
  const result = await fetchOzonSales(
    async (path) =>
      path.includes("fbs")
        ? { result: { postings: [posting], has_next: false } }
        : { result: [{ ...posting, in_process_at: "2026-09-28T06:00:00Z" }] },
    now,
  );
  assert.equal(result.partial, false);
  assert.equal(result.rows[0].value.source, "ozon_fbo");
  const partial = await fetchOzonSales(async (path) => {
    if (path.includes("fbo")) throw new Error("403");
    return { result: { postings: [posting] } };
  }, now);
  assert.equal(partial.partial, true);
  await assert.rejects(
    fetchOzonSales(async () => {
      throw new Error("403");
    }, now),
  );
  assert.equal(latest(result.rows).length, 1);
});
