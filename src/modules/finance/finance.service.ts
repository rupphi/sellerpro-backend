import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Store } from "@prisma/client";
import { db } from "../../infrastructure/clients";
import { decrypt } from "../../common/security";
import { request } from "../../integrations/marketplaces/transport";
import { ownedStore } from "../stores/stores.service";
import { financePeriod, financeTotals, readFinanceReports, type FinanceReport } from "./finance.domain";

export async function financeReport(userId: string, storeId: string, input: unknown) {
  const store = await ownedStore(userId, storeId), period = financePeriod.parse(input);
  const snapshot = await db.financeSnapshot.findUnique({ where: { storeId_from_to: { storeId, ...period } } });
  const task = await db.task.findFirst({ where: { storeId, kind: "finance", status: { in: ["queued", "running", "retrying"] } }, select: { id: true, progress: true, payload: true } });
  const data = snapshot?.data as { reports: FinanceReport[]; excluded: number } | null;
  const warnings = ["Số liệu theo kỳ quyết toán của sàn, không theo ngày đặt đơn. Tiền thanh toán trong báo cáo chưa xác nhận đã vào ngân hàng.", "Chưa tính lợi nhuận: cần giá vốn, thuế và chi phí ngoài sàn. Không trừ quảng cáo lần nữa nếu đã nằm trong khoản khấu trừ."];
  if (store.platform !== "wb") warnings.unshift("Báo cáo tài chính Ozon chưa được kết nối. Không sử dụng số liệu WB thay thế.");
  if (snapshot?.error) warnings.unshift(snapshot.error);
  if (data?.excluded) warnings.unshift(`${data.excluded} báo cáo có kỳ vượt khoảng ngày đã chọn, không được cộng vào tổng.`);
  return { period, supported: store.platform === "wb", status: snapshot?.status || "pending", checkedAt: snapshot?.checkedAt || null,
    succeededAt: snapshot?.succeededAt || null, reports: data?.reports || [], totals: data ? financeTotals(data.reports) : [], warnings, task };
}
export async function queueFinance(userId: string, storeId: string, input: unknown) {
  const store = await ownedStore(userId, storeId), period = financePeriod.parse(input);
  if (store.platform !== "wb" || store.demo) throw new BadRequestException("Chưa hỗ trợ đồng bộ quyết toán cho cửa hàng này.");
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation:${userId}`}))::text`;
    const pending = await tx.task.findFirst({ where: { storeId, kind: "finance", status: { in: ["queued", "running", "retrying"] } } });
    if (pending) {
      const p = pending.payload as any;
      if (p.from !== period.from || p.to !== period.to) throw new ConflictException("Đang cập nhật một kỳ tài chính khác. Vui lòng chờ hoàn tất.");
      return { id: pending.id, status: pending.status };
    }
    if (await tx.task.count({ where: { storeId, kind: "finance", createdAt: { gte: new Date(Date.now() - 60000) } } }))
      throw new ConflictException("Vui lòng chờ một phút trước lần cập nhật tài chính tiếp theo.");
    return tx.task.create({ data: { storeId, kind: "finance", payload: period }, select: { id: true, status: true } });
  });
}
/** Called under worker account lease. Read-only marketplace job; publish only complete snapshots. */
export async function syncFinance(store: Store, input: unknown, progress: (n: number) => Promise<void>) {
  const period = financePeriod.parse(input);
  if (store.platform !== "wb" || store.demo) throw new Error("Chưa hỗ trợ nguồn quyết toán này.");
  const where = { storeId_from_to: { storeId: store.id, ...period } };
  await db.financeSnapshot.upsert({ where, create: { storeId: store.id, ...period, status: "syncing" }, update: { status: "syncing", error: null } });
  try {
    const { apiKey } = decrypt(store.credentials);
    const data = await readFinanceReports(body => request(store.fingerprint, "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list", { Authorization: apiKey }, body), period, progress);
    financeTotals(data.reports); // Validate totals before publishing.
    await progress(95);
    await db.financeSnapshot.update({ where, data: { status: "ready", data, checkedAt: new Date(), succeededAt: new Date(), error: null } });
    return { errors: [], message: `Đã cập nhật ${data.reports.length} báo cáo quyết toán.` };
  } catch (e) {
    await db.financeSnapshot.update({ where, data: { status: "unavailable", checkedAt: new Date(), error: "Chưa cập nhật được quyết toán. Số liệu cũ (nếu có) được giữ nguyên. Kiểm tra quyền Tài chính hoặc thử lại sau." } });
    throw e;
  }
}
