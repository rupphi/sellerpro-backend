import "reflect-metadata";
import type { Product, Store } from "@prisma/client";
import { db, redis } from "../../infrastructure/clients";
import { adapter } from "../../integrations/marketplaces/adapters";
import { CatalogItem, effective, PriceChange } from "./pricing.domain";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function reconcile(store: Store, progress: (n: number) => Promise<void>, scope: "all" | "catalog" = "all", snapshot?: CatalogItem[], publishReady = true) {
    const api = adapter(store);
    if (store.demo &&
        !snapshot && (await db.product.count({ where: { storeId: store.id } }))) {
        await progress(90);
        if (publishReady) await db.store.update({
            where: { id: store.id },
            data: { lastSyncAt: new Date(), status: "ready" },
        });
        return;
    }
    const catalog = snapshot ? (scope === "all" && api.hydratePrices ? await api.hydratePrices(snapshot, progress) : snapshot) : await api.catalog(progress, scope === "catalog");
    for (const p of catalog) {
        const metadata = { article: p.article, title: p.title, brand: p.brand, category: p.category, image: p.image, stock: p.stock };
        await db.product.upsert({
            where: {
                storeId_externalId: { storeId: store.id, externalId: p.externalId },
            },
            create: { storeId: store.id, ...p, ...(scope === "catalog" ? { price: 0, salePrice: 0, minPrice: 0, oldPrice: 0, discount: 0, raw: {} } : {}) },
            update: { ...(scope === "catalog" ? metadata : p), version: { increment: 1 } },
        });
    }
    if (publishReady) await db.store.update({
        where: { id: store.id },
        data: { lastSyncAt: new Date(), status: "ready" },
    });
    return catalog;
}
export async function updatePrices(store: Store, changes: PriceChange[], taskId: string, progress: (n: number) => Promise<void>, guard = false, preserveLocks = false) {
    const api = adapter(store), errors: string[] = [], submitted: Product[] = [];
    for (let i = 0; i < changes.length; i++) {
        await progress(Math.round((i / changes.length) * 65));
        const change = { ...changes[i] }, p = await db.product.findFirst({
            where: { id: change.id, storeId: store.id },
        });
        if (!p) {
            errors.push("Không tìm thấy sản phẩm.");
            continue;
        }
        if (preserveLocks)
            change.locked = p.locked;
        if (!guard && p.version !== change.version) {
            errors.push(`${p.article}: dữ liệu đã thay đổi; tải lại và lưu.`);
            continue;
        }
        const target = store.platform === "ozon"
            ? effective(change.price, change.discount)
            : change.price;
        // Preserve the intended price separately from observations. Sync must never lower it.
        await db.product.update({
            where: { id: p.id },
            data: {
                locked: change.locked,
                targetPrice: change.locked ? target : null,
                targetDiscount: change.locked ? change.discount : null,
                protection: change.locked ? "pending" : "off",
            },
        });
        await db.audit.create({
            data: {
                storeId: store.id,
                taskId,
                productId: p.id,
                action: guard ? "guard.requested" : "price.requested",
                before: { price: p.price, discount: p.discount, locked: p.locked },
                after: change,
            },
        });
        try {
            if (!store.demo) {
                const allow = await redis.set(`write:${store.fingerprint}:${p.externalId}`, taskId, "PX", 365000, "NX");
                if (!allow)
                    throw new Error("Vừa cập nhật gần đây; chờ ít nhất 6 phút để bảo đảm giới hạn 10 lần/giờ.");
            }
            await api.write(p, target, store.platform === "ozon" ? 0 : change.discount, change.locked);
            if (store.demo)
                await db.product.update({
                    where: { id: p.id },
                    data: {
                        price: target,
                        discount: change.discount,
                        salePrice: effective(target, change.discount),
                        minPrice: change.locked
                            ? effective(target, change.discount)
                            : p.minPrice,
                        version: { increment: 1 },
                    },
                });
            submitted.push({
                ...p,
                price: target,
                discount: change.discount,
                locked: change.locked,
            });
        }
        catch (e) {
            errors.push(`${p.article}: ${(e as Error).message}`);
            await db.product.update({
                where: { id: p.id },
                data: { protection: change.locked ? "attention" : "off" },
            });
        }
        await progress(Math.round(((i + 1) / changes.length) * 65));
    }
    if (submitted.length) {
        if (!store.demo) {
            await pause(2500);
            await reconcile(store, async () => { });
        }
        for (const expected of submitted) {
            const actual = await db.product.findUniqueOrThrow({
                where: { id: expected.id },
            });
            const same = actual.price === expected.price &&
                actual.discount === expected.discount;
            const floorOk = store.demo ||
                store.platform !== "ozon" ||
                !expected.locked ||
                (actual.minPrice >= Math.max(expected.price, expected.minPrice) &&
                    (actual.raw as any).autoAction === false &&
                    (actual.raw as any).autoAdd === false &&
                    (actual.raw as any).ozonActions === false &&
                    actual.salePrice >= expected.price);
            const state = !expected.locked
                ? "off"
                : !same || !floorOk
                    ? "attention"
                    : store.demo
                        ? "demo"
                        : store.platform === "wb"
                            ? "monitoring"
                            : "floor_verified";
            await db.product.update({
                where: { id: actual.id },
                data: { protection: state, checkedAt: new Date() },
            });
            await db.audit.create({
                data: {
                    storeId: store.id,
                    taskId,
                    productId: actual.id,
                    action: same && floorOk ? "price.verified" : "price.needs_review",
                    after: {
                        price: actual.price,
                        salePrice: actual.salePrice,
                        minPrice: actual.minPrice,
                        protection: state,
                    },
                },
            });
            if (!same || !floorOk)
                errors.push(`${actual.article}: sàn chưa xác nhận đủ giá/khóa; cần kiểm tra lại.`);
        }
    }
    return {
        updated: submitted.length,
        errors,
        notice: store.platform === "wb"
            ? "WB: khôi phục định kỳ; khóa auto-action cần thiết lập trong Seller."
            : "Ozon: đã gửi giá sàn; khuyến mại đã lên lịch và ưu đãi do Ozon tài trợ cần kiểm tra riêng.",
    };
}
export async function guardPrices(store: Store, taskId: string, progress: (n: number) => Promise<void>) {
    await reconcile(store, progress);
    const locked = await db.product.findMany({
        where: { storeId: store.id, locked: true, targetPrice: { not: null } },
    });
    const changes = locked.filter(p => p.price !== p.targetPrice || p.discount !== (p.targetDiscount || 0) ||
        store.platform === "ozon" || p.protection === "pending").map(p => ({ id: p.id, version: p.version, price: p.targetPrice!, discount: p.targetDiscount || 0, locked: true }));
    const result = changes.length
        ? await updatePrices(store, changes, taskId, progress, true)
        : { updated: 0, errors: [] };
    await db.store.update({ where: { id: store.id }, data: { lastGuardAt: new Date() } });
    return result;
}
