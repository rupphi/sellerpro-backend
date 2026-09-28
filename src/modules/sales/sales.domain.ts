import { z } from "zod";

export type SalesRow = {
  source: string; externalKey: string; orderKey: string;
  kind: "order" | "sale" | "return";
  occurredAt: Date; channel: "fbo" | "fbs" | "unknown";
  status: string; article: string; productKey: string; title: string;
  quantity: number; amount: number | null; currency: string;
};
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, "Ngày không hợp lệ.");
export const periodSchema = z.object({
  from: dateOnly, to: dateOnly,
  compareFrom: dateOnly.optional(), compareTo: dateOnly.optional(),
  channel: z.enum(["all", "fbo", "fbs", "unknown"]).default("all"),
}).refine(v => v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 < 45,
  "Chọn khoảng ngày hợp lệ, tối đa 45 ngày.")
  .refine(v => (!v.compareFrom && !v.compareTo) || (!!v.compareFrom && !!v.compareTo &&
    v.compareFrom <= v.compareTo && v.compareTo < v.from &&
    Date.parse(v.compareTo) - Date.parse(v.compareFrom) === Date.parse(v.to) - Date.parse(v.from)),
  "Kỳ so sánh phải nằm trước kỳ báo cáo và có cùng số ngày.");

export function comparisonPeriod(p: { from: string; to: string; compareFrom?: string; compareTo?: string }) {
  const days = (Date.parse(p.to) - Date.parse(p.from)) / 86400000 + 1;
  const day = (offset: number) => new Date(Date.parse(p.from) + offset * 86400000).toISOString().slice(0, 10);
  const compareFrom = p.compareFrom || day(-days), compareTo = p.compareTo || day(-1);
  const comparison = bounds(compareFrom, compareTo);
  return { compareFrom, compareTo, comparisonStart: comparison.start, comparisonEnd: comparison.end };
}
export function funnelSourceKey(p: { from: string; to: string; compareFrom?: string; compareTo?: string }) {
  const c = comparisonPeriod(p);
  return `wb_funnel:${p.from}:${p.to}:${c.compareFrom}:${c.compareTo}`;
}

/** Marketplace reporting day, never the browser/server's local timezone. */
export function bounds(from: string, to: string) {
  const start = new Date(from + "T00:00:00+03:00");
  const end = new Date(Date.parse(to + "T00:00:00+03:00") + 86400000);
  return { start, end, previous: new Date(start.getTime() - (end.getTime() - start.getTime())) };
}
export function at(value: unknown, moscow = false): Date {
  if (typeof value !== "string" || !value) throw new Error("Thiếu ngày giao dịch.");
  const d = new Date(moscow && !/(Z|[+-]\d\d:\d\d)$/i.test(value) ? value + "+03:00" : value);
  if (!Number.isFinite(d.getTime())) throw new Error("Ngày giao dịch không hợp lệ.");
  return d;
}
export function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Math.abs(Number(value));
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? Math.round(n * 100) : null;
}
export function wbRows(rows: any[], kind: "order" | "transaction"): SalesRow[] {
  return rows.map(row => {
    if (!row.srid) throw new Error("WB thiếu mã liên kết đơn hàng.");
    const event = kind === "order" ? "order" : String(row.saleID).startsWith("S") ? "sale" : String(row.saleID).startsWith("R") ? "return" : null;
    if (!event) throw new Error("WB trả loại giao dịch chưa được hỗ trợ.");
    const channel = row.warehouseType === "Склад WB" ? "fbo" : row.warehouseType === "Склад продавца" ? "fbs" : "unknown";
    return {
      source: kind === "order" ? "wb_orders" : "wb_sales", externalKey: String(kind === "order" ? row.srid : row.saleID),
      orderKey: String(row.srid), kind: event, occurredAt: at(row.date, true), channel,
      status: event === "order" ? (row.isCancel === true ? "cancelled" : "ordered") : event === "sale" ? "delivered" : "returned",
      article: String(row.supplierArticle || ""), productKey: String(row.nmId || ""), title: String(row.subject || ""),
      quantity: 1,
      amount: kind === "order" ? money(Number(row.totalPrice) * (1 - Number(row.discountPercent || 0) / 100)) : money(row.priceWithDisc),
      currency: "RUB",
    } as SalesRow;
  });
}
export function ozonOrders(postings: any[], channel: "fbo" | "fbs"): SalesRow[] {
  return postings.flatMap(posting => {
    if (!posting.posting_number || !Array.isArray(posting.products)) throw new Error("Ozon thiếu dữ liệu kiện hàng.");
    return posting.products.map((p: any) => {
      if (!p.sku || !Number.isInteger(p.quantity) || p.quantity <= 0) throw new Error("Ozon thiếu mã hoặc số lượng sản phẩm.");
      const value = money(p.price);
      return {
        source: `ozon_${channel}`, externalKey: `${posting.posting_number}:${p.sku}`, orderKey: String(posting.posting_number),
        kind: "order", occurredAt: at(posting.in_process_at || posting.created_at), channel,
        status: posting.status === "cancelled" ? "cancelled" : posting.status === "delivered" ? "delivered" : "processing",
        article: String(p.offer_id || ""), productKey: String(p.sku), title: String(p.name || ""), quantity: p.quantity,
        amount: value === null ? null : value * p.quantity, currency: p.currency_code || "RUB",
      } as SalesRow;
    });
  });
}
export function summarize(rows: SalesRow[], start: Date, end: Date) {
  const period = rows.filter(r => r.occurredAt >= start && r.occurredAt < end);
  const orders = period.filter(r => r.kind === "order");
  const distinct = (items: SalesRow[]) => new Set(items.map(r => r.orderKey)).size;
  const values = (kind: SalesRow["kind"]) => {
    const items = period.filter(r => r.kind === kind);
    const missing = items.filter(r => r.amount === null || r.currency !== "RUB").length;
    const known = items.reduce((sum, r) => sum + (r.currency === "RUB" ? r.amount || 0 : 0), 0);
    return { value: missing ? null : known, known, missing, count: distinct(items), units: items.reduce((sum,r) => sum + r.quantity,0) };
  };
  const sales = values("sale"), returns = values("return"), placed = values("order");
  const cohort = { ordered: distinct(orders), delivered: 0, returned: 0, cancelled: 0, pending: 0 };
  const grouped = new Map<string, SalesRow[]>();
  for (const row of rows) grouped.set(row.orderKey, [...(grouped.get(row.orderKey) || []), row]);
  for (const key of new Set(orders.map(r => r.orderKey))) {
    const events = grouped.get(key)!;
    // Any return is a return-affected order, not a claim that all its items were refunded.
    if (events.some(r => r.kind === "return")) cohort.returned++;
    else if (events.some(r => r.kind === "sale" || r.status === "delivered")) cohort.delivered++;
    else if (events.every(r => r.status === "cancelled")) cohort.cancelled++;
    else cohort.pending++;
  }
  return {
    orders: distinct(orders), units: placed.units, orderedValue: placed.value,
    fbo: distinct(orders.filter(r => r.channel === "fbo")), fbs: distinct(orders.filter(r => r.channel === "fbs")), unknown: distinct(orders.filter(r => r.channel === "unknown")),
    sales, returns, netRevenue: sales.value === null || returns.value === null ? null : sales.value - returns.value,
    cohort, cancelled: distinct(orders.filter(r => r.status === "cancelled")),
  };
}
