import { Store } from "@prisma/client";
import { db } from "../../infrastructure/clients";
import { decrypt } from "../../common/security";
import { request } from "../../integrations/marketplaces/transport";
import { comparisonPeriod, funnelSourceKey, periodSchema, wbRows, SalesRow } from "./sales.domain";

export type SalesCall = (host: string, path: string, body?: unknown) => Promise<any>;

// Cursor completion is mandatory. Never publish a truncated source as complete.
export async function readWbLedger(call: SalesCall, kind: "orders" | "sales", from: Date) {
  let cursor = new Date(from.getTime() + 3 * 3600000).toISOString().replace("Z", "");
  const rows: SalesRow[] = [];
  for (let page = 0; page < 30; page++) {
    const result = await call("statistics-api", `/api/v1/supplier/${kind}?dateFrom=${encodeURIComponent(cursor)}&flag=0`);
    if (!Array.isArray(result)) throw new Error("WB trả dữ liệu không đúng định dạng.");
    if (!result.length) return rows;
    rows.push(...wbRows(result, kind === "orders" ? "order" : "transaction"));
    const next = result.at(-1)?.lastChangeDate;
    if (typeof next !== "string" || next <= cursor) throw new Error("WB chưa trả hết dữ liệu. Vui lòng thử đồng bộ lại.");
    cursor = next;
  }
  throw new Error("Chưa đọc hết dữ liệu cửa hàng; cần mở rộng tác vụ đồng bộ.");
}
export async function readWbFunnel(call: SalesCall, from: string, to: string, compareFrom?: string, compareTo?: string) {
  const c = comparisonPeriod(periodSchema.parse({ from, to, compareFrom, compareTo }));
  const products: any[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 100000; offset += 1000) {
    const response = await call("seller-analytics-api", "/api/analytics/v3/sales-funnel/products", {
      selectedPeriod: { start: from, end: to }, pastPeriod: { start: c.compareFrom, end: c.compareTo },
      nmIds: [], brandNames: [], subjectIds: [], tagIds: [], skipDeletedNm: false, limit: 1000, offset,
    });
    const page = response.data?.products;
    if (!Array.isArray(page)) throw new Error("Chưa đọc được thống kê lượt xem và giỏ hàng.");
    for (const row of page) {
      const id = String(row.product?.nmId || "");
      if (!id || seen.has(id)) throw new Error("Trang thống kê sản phẩm bị trùng.");
      seen.add(id);
      const parse = (s: any) => {
        if (!s || ![s.openCount, s.cartCount, s.orderCount, s.buyoutCount].every(n => Number.isInteger(n) && n >= 0)) throw new Error("Thống kê phễu chưa đủ chỉ số.");
        return { views: s.openCount, carts: s.cartCount, orders: s.orderCount, buyouts: s.buyoutCount };
      };
      products.push({ productKey: id, article: row.product.vendorCode, title: row.product.title,
        current: parse(row.statistic?.selected), previous: row.statistic?.past ? parse(row.statistic.past) : null });
    }
    if (page.length < 1000) return { products };
  }
  throw new Error("Chưa đọc hết thống kê sản phẩm.");
}

/** Worker already holds the account lease. This use case only reads the marketplace. */
export async function syncSales(store: Store, input: unknown, progress: (n: number) => Promise<void>) {
  const period = periodSchema.parse(input);
  if (store.platform !== "wb") throw new Error("Dữ liệu đơn Ozon đang chờ xác minh API mới. Chưa có số liệu để báo cáo.");
  if (store.demo) throw new Error("Đồng bộ phễu cần cửa hàng thật; kiểm thử dùng nguồn dữ liệu cô lập.");
  const creds = decrypt(store.credentials);
  const call: SalesCall = (host, path, body) => request(store.fingerprint, `https://${host}.wildberries.ru${path}`, { Authorization: creds.apiKey }, body);
  const now = new Date();
  const earliest = new Date(now.getTime() - 89 * 86400000);
  const errors: string[] = [];
  for (const [index, kind] of (["orders", "sales"] as const).entries()) {
    const source = `wb_${kind}`;
    const old = await db.salesSource.findUnique({ where: { storeId_source: { storeId: store.id, source } } });
    await db.salesSource.upsert({ where: { storeId_source: { storeId: store.id, source } },
      create: { storeId: store.id, source, status: "syncing" }, update: { status: "syncing" } });
    try {
      // Re-read overlap for late price/status corrections; retain older local history.
      const from = old?.coveredTo && old.coveredFrom ? new Date(Math.max(earliest.getTime(), old.coveredTo.getTime() - 3 * 86400000)) : earliest;
      const rows = await readWbLedger(call, kind, from);
      for (let i = 0; i < rows.length; i += 500) {
        await progress(index * 35 + Math.round(30 * i / Math.max(1, rows.length)));
        await db.$transaction(rows.slice(i, i + 500).map(row => db.salesEvent.upsert({
          where: { storeId_source_externalKey: { storeId: store.id, source, externalKey: row.externalKey } },
          create: { ...row, storeId: store.id, collectedAt: now }, update: { ...row, collectedAt: now },
        })));
      }
      await db.salesSource.upsert({ where: { storeId_source: { storeId: store.id, source } },
        create: { storeId: store.id, source, status: "ready", coveredFrom: from, coveredTo: now, checkedAt: now },
        update: { status: "ready", coveredFrom: old?.coveredFrom || from, coveredTo: now, checkedAt: now, error: null },
      });
    } catch {
      const error = kind === "orders" ? "Chưa cập nhật đủ đơn đặt. Kiểm tra quyền Thống kê hoặc thử lại sau." : "Chưa cập nhật đủ bán hàng/trả hàng. Kiểm tra quyền Thống kê hoặc thử lại sau.";
      errors.push(error);
      await db.salesSource.upsert({ where: { storeId_source: { storeId: store.id, source } },
        create: { storeId: store.id, source, status: "unavailable", error }, update: { status: "unavailable", checkedAt: now, error } });
    }
  }
  await progress(75);
  const source = funnelSourceKey(period);
  try {
    const data = await readWbFunnel(call, period.from, period.to, period.compareFrom, period.compareTo);
    await db.salesSource.upsert({ where: { storeId_source: { storeId: store.id, source } },
      create: { storeId: store.id, source, status: "ready", data, checkedAt: now },
      update: { status: "ready", data, error: null, checkedAt: now } });
  } catch {
    const error = "Chưa cập nhật lượt xem/giỏ hàng. Kiểm tra quyền Phân tích của khóa truy cập.";
    errors.push(error);
    await db.salesSource.upsert({ where: { storeId_source: { storeId: store.id, source } },
      create: { storeId: store.id, source, status: "unavailable", error }, update: { status: "unavailable", checkedAt: now, error } });
  }
  return { errors, message: "Đã cập nhật phễu bán hàng." };
}
