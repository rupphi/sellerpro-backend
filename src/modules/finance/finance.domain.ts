import { z } from "zod";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const date = new Date(s + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
});
export const financePeriod = z.object({ from: day, to: day }).refine(p => {
  const span = (Date.parse(p.to) - Date.parse(p.from)) / 86400000 + 1;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
  return span >= 1 && span <= 45 && p.from >= "2025-01-01" && p.to <= today;
}, "Chọn từ 1 đến 45 ngày, từ năm 2025 đến hôm nay.");

export const financeFields = ["retailAmountSum", "forPaySum", "bankPaymentSum", "deliveryServiceSum", "paidStorageSum", "paidAcceptanceSum", "deductionSum", "penaltySum", "additionalPaymentSum", "cashbackAmountSum", "cashbackDiscountSum", "cashbackCommissionChangeSum"] as const;
export type MoneyField = typeof financeFields[number];
export type Amounts = Record<MoneyField, number | null>;
export type FinanceReport = { id: string; from: string; to: string; created: string; currency: string; reportType: number; amounts: Amounts };

/** Integer kopecks only, no float multiplication or silent rounding. Missing != zero. */
export function kopecks(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(value)) throw new Error("Số tiền quyết toán không hợp lệ.");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const n = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))) * (value.startsWith("-") ? -1n : 1n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Số tiền vượt giới hạn xử lý.");
  return Number(n);
}
export function normalizeFinance(row: any): FinanceReport {
  const id = typeof row?.reportId === "number" && Number.isSafeInteger(row.reportId) ? String(row.reportId) : row?.reportId;
  if (typeof id !== "string" || !/^\d+$/.test(id) || !/^[A-Z]{3}$/.test(row.currency) || !Number.isInteger(row.reportType)) throw new Error("Báo cáo quyết toán chưa đủ thông tin.");
  const from = day.parse(row.dateFrom), to = day.parse(row.dateTo);
  if (from > to) throw new Error("Kỳ quyết toán không hợp lệ.");
  return { id, from, to, created: day.parse(row.createDate), currency: row.currency, reportType: row.reportType,
    amounts: Object.fromEntries(financeFields.map(k => [k, kopecks(row[k])])) as Amounts };
}
export function financeTotals(rows: FinanceReport[]) {
  return [...new Set(rows.map(r => r.currency))].map(currency => ({ currency,
    amounts: Object.fromEntries(financeFields.map(key => {
      const values = rows.filter(r => r.currency === currency).map(r => r.amounts[key]);
      if (values.some(v => v === null)) return [key, null];
      const total = values.reduce<bigint>((sum, n) => sum + BigInt(n!), 0n);
      if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("Tổng quyết toán vượt giới hạn xử lý.");
      return [key, Number(total)];
    })) as Amounts,
  }));
}

/** Daily reports only. Never combine daily + weekly (would double-count). */
export async function readFinanceReports(call: (body: unknown) => Promise<unknown>, period: { from: string; to: string }, progress: (n: number) => Promise<void> = async () => {}) {
  const reports: FinanceReport[] = [], seen = new Set<string>();
  let excluded = 0;
  for (let offset = 0; offset < 50000; offset += 1000) {
    const page = await call({ dateFrom: `${period.from}T00:00:00+03:00`, dateTo: `${period.to}T23:59:59+03:00`, period: "daily", limit: 1000, offset });
    if (page === null) return { reports, excluded }; // HTTP 204
    if (!Array.isArray(page)) throw new Error("Sàn trả báo cáo tài chính không đúng định dạng.");
    for (const row of page) {
      const report = normalizeFinance(row);
      if (seen.has(report.id)) throw new Error("Danh sách quyết toán bị trùng. Hãy cập nhật lại.");
      seen.add(report.id);
      if (report.from < period.from || report.to > period.to) { excluded++; continue; }
      reports.push(report);
    }
    await progress(Math.min(85, 15 + offset / 1000));
    if (page.length < 1000) return { reports, excluded };
  }
  throw new Error("Chưa đọc hết báo cáo tài chính; không công bố số liệu thiếu.");
}
