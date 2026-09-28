import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { db } from "../../infrastructure/clients";
import { ownedStore } from "../stores/stores.service";
import { bounds, comparisonPeriod, funnelSourceKey, periodSchema, summarize, SalesRow } from "./sales.domain";

export const ledgerQuery = z.object({
  from: z.string(), to: z.string(), channel: z.enum(["all", "fbo", "fbs", "unknown"]).default("all"),
  search: z.string().trim().max(100).default(""), kind: z.enum(["all", "order", "sale", "return"]).default("all"),
  cursor: z.string().max(100).optional(),
});
function checkedPeriod(input: unknown) {
  const p = periodSchema.parse(input), b = bounds(p.from, p.to);
  if (b.start > new Date()) throw new BadRequestException("Ngày bắt đầu không được ở tương lai.");
  if (new Date(p.to + "T00:00:00+03:00") > new Date()) throw new BadRequestException("Ngày kết thúc không được ở tương lai.");
  return { ...p, ...b, ...comparisonPeriod(p) };
}
export async function salesReport(userId: string, storeId: string, input: unknown) {
  const store = await ownedStore(userId, storeId), p = checkedPeriod(input);
  const [sources, records, task] = await Promise.all([
    db.salesSource.findMany({ where: { storeId, source: { in: ["wb_orders", "wb_sales", funnelSourceKey(p)] } } }),
    db.salesEvent.findMany({ where: { storeId, occurredAt: { gte: p.comparisonStart }, ...(p.channel === "all" ? {} : { channel: p.channel }) }, take: 100001 }),
    db.task.findFirst({ where: { storeId, kind: "sales", status: { in: ["queued", "running", "retrying"] } }, select: { id: true, status: true, progress: true } }),
  ]);
  if (records.length > 100000) throw new BadRequestException("Khoảng ngày có quá nhiều giao dịch. Hãy chọn khoảng ngắn hơn.");
  const rows = records as SalesRow[];
  const catalog = await db.product.findMany({ where: { storeId }, select: { externalId: true, title: true, article: true } });
  const catalogById = new Map(catalog.map(p => [p.externalId, p]));
  for (const row of rows) {
    const product = catalogById.get(row.productKey);
    if (product) { row.title = product.title; row.article = product.article; }
  }
  const complete = (source: string, start: Date, end: Date) => {
    const s = sources.find(x => x.source === source);
    return !!s && s.status === "ready" && !!s.coveredFrom && !!s.coveredTo && s.coveredFrom <= start && s.coveredTo.getTime() >= Math.min(end.getTime(), Date.now() - 3600000);
  };
  const metric = (start: Date, end: Date) => {
    const summary = summarize(rows, start, end);
    return { ...summary, ordersReady: complete("wb_orders", start, end), salesReady: complete("wb_sales", start, end) };
  };
  const current = metric(p.start, p.end), previous = metric(p.comparisonStart, p.comparisonEnd);
  const daily = [];
  for (let t = p.start.getTime(); t < p.end.getTime(); t += 86400000) {
    const data = summarize(rows, new Date(t), new Date(t + 86400000));
    daily.push({ day: new Date(t + 3 * 3600000).toISOString().slice(0, 10), orders: data.orders, revenue: data.netRevenue });
  }
  const byArticle = new Map<string, SalesRow[]>();
  for (const r of rows) {
    const key = r.productKey || r.article;
    if (key) byArticle.set(key, [...(byArticle.get(key) || []), r]);
  }
  const products = [...byArticle.entries()].map(([productKey, group]) => {
    const s = summarize(group, p.start, p.end);
    return { productKey, article: group[0].article, title: group[0].title, ...s };
  }).filter(p => p.orders || p.sales.count || p.returns.count).sort((a, b) => b.returns.known - a.returns.known || b.orders - a.orders).slice(0, 20);
  const trafficSource = sources.find(s => s.source.startsWith("wb_funnel:"));
  const traffic = p.channel === "all" && trafficSource?.status === "ready" ? trafficSource.data : null;
  const warnings = [
    ...(store.platform === "ozon" ? ["Ozon: đang chờ xác minh API đơn hàng và tài chính mới. Chưa có dữ liệu báo cáo."] : []),
    ...(!current.ordersReady ? ["Đơn đặt chưa đủ dữ liệu cho toàn bộ khoảng ngày. Hãy đồng bộ hoặc chọn khoảng ngắn hơn."] : []),
    ...(!current.salesReady ? ["Bán hàng/trả hàng chưa đủ dữ liệu cho toàn bộ khoảng ngày; không kết luận doanh thu từ phần đã có."] : []),
    ...(current.sales.missing + current.returns.missing ? ["Một số giao dịch chưa có giá trị hợp lệ; tổng tiền chưa đầy đủ."] : []),
    ...(p.end > new Date() ? ["Khoảng ngày có hôm nay hoặc ngày chưa kết thúc; chưa so sánh đủ ngày với kỳ trước."] : []),
    ...sources.filter(s => s.error).map(s => s.error!),
  ];
  return { platform: store.platform, timezone: "Europe/Moscow", currency: "RUB", current, previous, daily, products,
    traffic, trafficCheckedAt: trafficSource?.checkedAt || null, sources: sources.map(({ data, ...s }) => s), warnings, task,
    period: { from: p.from, to: p.to, previousFrom: p.compareFrom, previousTo: p.compareTo } };
}
export async function salesLedger(userId: string, storeId: string, input: unknown) {
  await ownedStore(userId, storeId);
  const q = ledgerQuery.parse(input), p = checkedPeriod(q);
  // Cursor must belong to the same tenant/store, even if a caller guesses another ID.
  if (q.cursor && !(await db.salesEvent.count({ where: { id: q.cursor, storeId } }))) throw new BadRequestException("Vị trí tải tiếp không hợp lệ.");
  const items = await db.salesEvent.findMany({ where: {
    storeId, occurredAt: { gte: p.start, lt: p.end }, ...(q.channel === "all" ? {} : { channel: q.channel }),
    ...(q.kind === "all" ? {} : { kind: q.kind }),
    ...(q.search ? { OR: ["orderKey", "article", "title"].map(field => ({ [field]: { contains: q.search, mode: "insensitive" } })) } : {}),
  }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
  return { items: items.slice(0, 50), nextCursor: items.length > 50 ? items[49].id : null };
}
export async function orderDetail(userId: string, storeId: string, eventId: string) {
  await ownedStore(userId, storeId);
  const event = await db.salesEvent.findFirst({ where: { id: eventId, storeId } });
  if (!event) throw new NotFoundException("Không tìm thấy đơn.");
  return db.salesEvent.findMany({ where: { storeId, orderKey: event.orderKey }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] });
}
export async function queueSales(userId: string, storeId: string, input: unknown) {
  const store = await ownedStore(userId, storeId), p = checkedPeriod(input);
  if (store.platform !== "wb") throw new BadRequestException("Đồng bộ Ozon đang chờ xác minh API mới.");
  if (p.comparisonStart.getTime() < Date.now() - 89 * 86400000) throw new BadRequestException("Lần đồng bộ này hỗ trợ 89 ngày gần nhất, gồm cả kỳ so sánh.");
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation:${userId}`}))::text`;
    const pending = await tx.task.findFirst({ where: { storeId, kind: "sales", status: { in: ["queued", "running", "retrying"] } } });
    if (pending) return pending;
    const recent = await tx.task.findFirst({ where: { storeId, kind: "sales", createdAt: { gte: new Date(Date.now() - 15 * 60000) } } });
    if (recent) throw new ConflictException("Phễu vừa được yêu cầu cập nhật. Vui lòng chờ 15 phút trước lần tiếp theo.");
    return tx.task.create({ data: { storeId, kind: "sales", payload: { from: p.from, to: p.to, compareFrom: p.compareFrom, compareTo: p.compareTo, channel: "all" } } });
  });
}
