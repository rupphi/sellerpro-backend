import { Prisma, Store } from "@prisma/client";
import { db, redis } from "../../infrastructure/clients";
import { adapter, Adapter } from "../../integrations/marketplaces/adapters";
import { randomUUID } from "node:crypto";
// Short read cooldown for manual requests; daily cadence is in automation settings.
const BUYER_PRICE_INTERVAL_MS = 30 * 60 * 1000;
/** Separate cache from catalog and locked-price targets; no marketplace writes. */
export async function syncBuyerPrices(store: Store, api: Adapter = adapter(store)) {
    const key = `buyer-prices:${store.fingerprint}`;
    const lease = randomUUID();
    if (!(await redis.set(key, lease, "PX", BUYER_PRICE_INTERVAL_MS, "NX")))
        return "busy";
    try {
        const current = await db.store.findUniqueOrThrow({
            where: { id: store.id },
        });
        if (current.buyerPricesCheckedAt &&
            Date.now() - current.buyerPricesCheckedAt.getTime() < BUYER_PRICE_INTERVAL_MS)
            return current.buyerPricesStatus;
        const result = await api.buyerPrices();
        const products = await db.product.findMany({
            where: { storeId: store.id },
            select: { id: true, externalId: true, article: true },
        });
        const keys = new Map<string, typeof products>();
        for (const p of products) {
            const id = store.platform === "wb" ? p.externalId : p.article;
            keys.set(id, [...(keys.get(id) || []), p]);
        }
        await db.$transaction(async (tx) => {
            // Incomplete coverage is not called the latest transaction. Keep last successful
            // snapshot and mark it stale instead of publishing a misleading partial result.
            if (!result.partial) {
                await tx.product.updateMany({
                    where: { storeId: store.id },
                    data: { buyerPrice: Prisma.DbNull },
                });
                for (const row of result.rows) {
                    const matches = keys.get(row.key);
                    if (matches?.length !== 1)
                        continue;
                    await tx.product.update({
                        where: { id: matches[0].id },
                        data: { buyerPrice: row.value },
                    });
                }
            }
            await tx.store.update({
                where: { id: store.id },
                data: {
                    buyerPricesCheckedAt: new Date(),
                    buyerPricesStatus: result.partial ? "partial" : "ready",
                },
            });
        }, { timeout: 30000 });
        return result.partial ? "partial" : "ready";
    }
    catch {
        await db.store.update({
            where: { id: store.id },
            data: {
                buyerPricesCheckedAt: new Date(),
                buyerPricesStatus: "unavailable",
            },
        });
        return "unavailable";
    }
    finally {
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, lease);
    }
}
