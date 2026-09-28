import type { PrismaClient } from "@prisma/client";
import { automationSettings, defaultSalesPeriod, defaultFinancePeriod, latestSlot } from "./automation.policy";
export async function scheduleAutomation(db: PrismaClient, demo: boolean, now = new Date()) {
    const stores = await db.store.findMany({
        where: { demo, lastSyncAt: { not: null } },
        include: { user: { select: { automation: true, automationUpdatedAt: true } } },
    });
    const slots = new Map<string, ReturnType<typeof latestSlot>>();
    for (const store of stores) {
        const config = automationSettings(store.user.automation);
        for (const kind of ["catalog", "buyer_prices", "sales", "finance", "guard"] as const) {
            if (!config[kind].enabled)
                continue;
            if (["sales", "finance"].includes(kind) && store.platform !== "wb") continue;
            const cacheKey = JSON.stringify([config.timezone, config[kind].times]);
            if (!slots.has(cacheKey))
                slots.set(cacheKey, latestSlot(config.timezone, config[kind].times, now));
            const slot = slots.get(cacheKey);
            const since = Math.max(store.createdAt.getTime(), store.user.automationUpdatedAt?.getTime() || 0);
            if (!slot || slot.at.getTime() < since)
                continue;
            const scheduleKey = `${store.id}:${kind}:${slot.key}`;
            await db.$transaction(async (tx) => {
                // Settings saves and all scheduler replicas share this lock.
                await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`automation:${store.userId}`}))::text`;
                // The store/account may have been deleted after the initial scan.
                if (!(await tx.store.count({ where: { id: store.id } })))
                    return;
                const current = await tx.user.findUniqueOrThrow({ where: { id: store.userId } });
                if (current.automationUpdatedAt?.getTime() !== store.user.automationUpdatedAt?.getTime())
                    return;
                if (kind === "guard" && !(await tx.product.count({ where: { storeId: store.id, locked: true } })))
                    return;
                if (await tx.task.count({ where: { storeId: store.id, status: { in: ["queued", "running", "retrying"] } } }))
                    return;
                await tx.task.upsert({
                    where: { scheduleKey }, update: {},
                    create: { storeId: store.id, kind, scheduleKey, payload: {
                            automatic: true, scheduledAt: slot.at.toISOString(),
                            automationVersion: current.automationUpdatedAt?.toISOString() || null,
                            ...(kind === "sales" ? defaultSalesPeriod(now) : {}),
                            ...(kind === "finance" ? defaultFinancePeriod(now) : {}),
                        } },
                });
            });
        }
    }
}
