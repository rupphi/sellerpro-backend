import "reflect-metadata";
import { Worker, Job, UnrecoverableError, DelayedError } from "bullmq";
import { randomUUID } from "node:crypto";
import { db, redis, queue, notify, taskQueueName } from "./infrastructure/clients";
import { env } from "./config/env";
import { syncBuyerPrices } from "./modules/pricing/buyer-price-sync.service";
import { scheduleAutomation } from "./modules/automation/automation.scheduler";
import { reconcile, updatePrices, guardPrices, refreshProtectionPrices } from "./modules/pricing/price-jobs";
import { syncSales } from "./modules/sales/sales-sync.service";
import { syncFinance } from "./modules/finance/finance.service";
import { runInitialization } from "./modules/automation/initialization.runner";
import type { CatalogItem } from "./modules/pricing/pricing.domain";
async function processTask(job: Job) {
    const task = await db.task.findUnique({
        where: { id: job.data.taskId },
        include: { store: true },
    });
    if (!task || ["completed", "needs_review", "failed", "cancelled"].includes(task.status))
        return;
    if (task.store.demo && env.NODE_ENV !== "test") {
        await db.task.update({
            where: { id: task.id },
            data: {
                status: "failed",
                error: "Cửa hàng thử nghiệm đã ngừng hoạt động.",
                finishedAt: new Date(),
            },
        });
        return;
    }
    const store = task.store, key = `account-lock:${store.fingerprint}`, token = randomUUID();
    const readOnly = ["sync", "catalog", "buyer_prices", "sales", "finance"].includes(task.kind);
    const replaySafe = readOnly && !(task.payload as any).initialization?.includes("guard") && !(task.payload as any).initializationGuard;
    // Lock protects a marketplace account across all worker replicas, not only a local process.
    const earlier = await db.task.count({
        where: {
            store: { fingerprint: store.fingerprint },
            status: { in: ["queued", "running", "retrying"] },
            OR: [
                { createdAt: { lt: task.createdAt } },
                { createdAt: task.createdAt, id: { lt: task.id } },
            ],
        },
    });
    // Release the worker slot while waiting, otherwise delayed retries can deadlock.
    if (earlier || !(await redis.set(key, token, "PX", 90000, "NX"))) {
        await job.moveToDelayed(Date.now() + 3000, job.token);
        throw new DelayedError();
    }
    let leaseLost = false;
    const heartbeat = setInterval(() => void redis
        .eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],90000) else return 0 end", 1, key, token)
        .then((n) => {
        if (!n)
            leaseLost = true;
    })
        .catch(() => {
        leaseLost = true;
    }), 20000);
    const progress = async (n: number) => {
        if (leaseLost)
            throw new Error("Kết nối bị gián đoạn. Vui lòng đồng bộ để kiểm tra lại.");
        await db.task.update({ where: { id: task.id }, data: { progress: n } });
        await job.updateProgress(n);
    };
    try {
        if (task.status === "running" && !replaySafe) {
            await reconcile(store, async () => { });
            throw new UnrecoverableError("Tác vụ bị gián đoạn sau khi bắt đầu ghi. Đã đọc lại giá; cần đối chiếu nhật ký trước khi gửi lại.");
        }
        const started = await db.$transaction(async (tx) => {
            if (task.scheduleKey) {
                await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`automation:${store.userId}`}))::text`;
                const owner = await tx.user.findUniqueOrThrow({ where: { id: store.userId } });
                const current = await tx.task.findUniqueOrThrow({ where: { id: task.id } });
                if (current.status === "cancelled" || (task.payload as any).automationVersion !== (owner.automationUpdatedAt?.toISOString() || null)) {
                    await tx.task.update({ where: { id: task.id }, data: { status: "cancelled", finishedAt: new Date() } });
                    return false;
                }
            }
            await tx.task.update({
                where: { id: task.id },
                data: {
                    status: "running",
                    startedAt: new Date(),
                    attempts: { increment: 1 },
                    error: null,
                },
            });
            return true;
        });
        if (!started)
            return;
        if (task.kind === "sync") await db.store.update({ where: { id: store.id }, data: { status: "syncing" } });
        let result: any = {};
        if (task.kind === "finance") {
            result = await syncFinance(store, task.payload, progress);
        }
        else if (task.kind === "sales") {
            result = await syncSales(store, task.payload, progress);
        }
        else if (readOnly) {
            let snapshot: CatalogItem[] | undefined;
            const pricing = async (report: (n: number) => Promise<void>) => {
                await reconcile(store, n => report(Math.round(n * .6)), "all", snapshot, task.kind !== "sync");
                const status = await syncBuyerPrices(store);
                if (status === "busy") {
                    if (!replaySafe) throw new UnrecoverableError("Chiết khấu đang được đồng bộ. Không tự lặp bước bảo vệ giá.");
                    await db.task.update({ where: { id: task.id }, data: { status: "queued" } });
                    await job.moveToDelayed(Date.now() + 15000, job.token);
                    throw new DelayedError();
                }
                await report(100);
                return status;
            };
            if (task.kind === "sync") result = await runInitialization(task.payload, store.platform, {
                catalog: async report => { snapshot = await reconcile(store, report, "catalog", undefined, false); },
                pricing,
                guard: report => guardPrices(store, task.id, report),
                sales: (period, report) => syncSales(store, period, report),
                finance: (period, report) => syncFinance(store, period, report),
            }, progress, new Date(), async state => {
                await db.task.update({ where: { id: task.id }, data: { result: state } });
            });
            else if (task.kind === "catalog") {
                await reconcile(store, progress, "catalog");
                result = { errors: [], message: "Đã cập nhật sản phẩm." };
            } else {
                const status = await pricing(progress);
                result = { errors: status === "ready" ? [] : ["Chưa cập nhật đủ chiết khấu và giá khách đã mua."], message: "Đã cập nhật giá cả và chiết khấu." };
            }
        }
        else if (task.kind === "prices")
            result = await updatePrices(store, (task.payload as any).changes, task.id, progress, false, (task.payload as any).preserveLocks === true);
        else if (task.kind === "locks") {
            const { locked, productIds } = task.payload as {
                locked: boolean;
                productIds: string[];
            };
            // Same account lease/FIFO as prices and guards; no competing lock writes.
            if (locked) {
                try {
                    await refreshProtectionPrices(store, async () => { }, productIds);
                } catch (error) {
                    throw new UnrecoverableError(`Chưa bật khóa giá: không đọc được giá hiện tại. Chưa gửi thay đổi sang sàn. ${(error as Error).message}`);
                }
            }
            const products = await db.product.findMany({
                where: { storeId: store.id, id: { in: productIds } },
            });
            if (!locked) {
                const changed = products.filter((p) => p.locked);
                await db.$transaction(async (tx) => {
                    await tx.product.updateMany({
                        where: { storeId: store.id, id: { in: changed.map((p) => p.id) } },
                        data: {
                            locked: false,
                            targetPrice: null,
                            targetDiscount: null,
                            protection: "off",
                            version: { increment: 1 },
                        },
                    });
                    if (changed.length)
                        await tx.audit.createMany({
                            data: changed.map((p) => ({
                                storeId: store.id,
                                taskId: task.id,
                                productId: p.id,
                                action: "lock.disabled",
                                before: { locked: true },
                                after: { locked: false },
                            })),
                        });
                });
                // Unlock never changes sale prices or re-enables marketplace promotions.
                result = { updated: changed.length, errors: [] };
            }
            else {
                const errors: string[] = [];
                const changes = products
                    .filter((p) => !p.locked || p.protection === "attention")
                    .flatMap((p) => {
                    const price = p.locked ? (p.targetPrice ?? p.price) : p.price;
                    const discount = p.locked
                        ? (p.targetDiscount ?? p.discount)
                        : p.discount;
                    if (p.currency !== "RUB" ||
                        price < 100 ||
                        discount < 0 ||
                        discount > 95 ||
                        (store.platform === "wb" &&
                            (price % 100 !== 0 || (p.raw as any).sizePricing)) ||
                        (store.platform === "ozon" && discount !== 0)) {
                        errors.push(`${p.article}: chưa hỗ trợ khóa mức giá này.`);
                        return [];
                    }
                    return [
                        { id: p.id, version: p.version, price, discount, locked: true },
                    ];
                });
                result = changes.length
                    ? await updatePrices(store, changes, task.id, progress)
                    : { updated: 0, errors: [] };
                result.errors.push(...errors);
            }
        }
        else if (task.kind === "guard") {
            result = await guardPrices(store, task.id, progress);
        }
        else throw new UnrecoverableError("Nhóm công việc chưa được hỗ trợ.");
        const needsReview = result.errors?.length > 0;
        if (task.kind === "sync") await db.store.update({ where: { id: store.id }, data: { status: needsReview ? "needs_review" : "ready", lastSyncAt: new Date() } });
        await db.task.update({
            where: { id: task.id },
            data: {
                status: needsReview ? "needs_review" : "completed",
                progress: 100,
                result,
                finishedAt: new Date(),
            },
        });
        if (task.kind !== "buyer_prices" || needsReview)
            await notify(store.userId, needsReview
                ? "Cần kiểm tra tác vụ"
                : task.kind === "sales" ? "Đã cập nhật phễu bán hàng"
                : task.kind === "finance" ? "Đã cập nhật báo cáo tài chính"
                : task.kind === "sync"
                    ? "Đồng bộ hoàn tất"
                    : "Đã kiểm tra giá", `${store.name}: ${needsReview ? result.errors.slice(0, 3).join(" ") : result.message || `${result.updated} sản phẩm được xử lý.`}`, needsReview ? "warning" : "success").catch(() => console.error("notification persistence unavailable", task.id));
    }
    catch (e) {
        if (e instanceof DelayedError)
            throw e;
        const message = (e as Error).message;
        if (replaySafe &&
            job.attemptsMade + 1 < (job.opts.attempts || 1) &&
            !(e instanceof UnrecoverableError)) {
            await db.task.update({
                where: { id: task.id },
                data: { status: "retrying", error: message },
            });
            throw e;
        }
        await db.task.update({
            where: { id: task.id },
            data: { status: "failed", error: message, finishedAt: new Date() },
        });
        if (task.kind === "sync")
            await db.store.update({
                where: { id: store.id },
                data: { status: "error" },
            });
        await notify(store.userId, "Tác vụ không hoàn tất", `${store.name}: ${message}`, "error");
        throw new UnrecoverableError(message);
    }
    finally {
        clearInterval(heartbeat);
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end", 1, key, token);
    }
}
const worker = new Worker(taskQueueName, processTask, {
    connection: redis as any,
    concurrency: env.WORKER_CONCURRENCY,
    lockDuration: 120000,
    maxStalledCount: 1,
});
worker.on("error", (e) => console.error("worker", e.message));
let dispatching = false;
let nextScheduleCheck = 0;
async function dispatch() {
    if (dispatching)
        return;
    dispatching = true;
    try {
        const tasks = await db.task.findMany({
            where: { status: "queued", store: { demo: env.NODE_ENV === "test" } },
            orderBy: { createdAt: "asc" },
            take: 100,
        });
        for (const task of tasks)
            await queue.add(task.kind, { taskId: task.id }, {
                jobId: task.id,
                attempts: ["sync", "catalog", "buyer_prices", "sales", "finance"].includes(task.kind) && !(task.payload as any).initialization?.includes("guard") && !(task.payload as any).initializationGuard ? 3 : 1,
                backoff: { type: "exponential", delay: 15000, jitter: 0.25 },
            });
        if (Date.now() >= nextScheduleCheck) {
            await scheduleAutomation(db, env.NODE_ENV === "test");
            nextScheduleCheck = Date.now() + 30000;
        }
    }
    catch (e) {
        console.error("dispatcher", (e as Error).name);
    }
    finally {
        dispatching = false;
    }
}
const interval = setInterval(() => void dispatch(), 3000);
void dispatch();
console.log(`Marketlane worker ready; concurrency=${env.WORKER_CONCURRENCY}`);
async function shutdown() {
    clearInterval(interval);
    await worker.close();
    await queue.close();
    await redis.quit();
    await db.$disconnect();
    process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
