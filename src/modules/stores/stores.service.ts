import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { db } from "../../infrastructure/clients";
import { digest, encrypt } from "../../common/security";
import { env } from "../../config/env";
import { automationSettings } from "../automation/automation.policy";
export async function ownedStore(userId: string, id: string) {
    const store = await db.store.findFirst({
        where: { id, userId, ...(env.NODE_ENV === "test" ? {} : { demo: false }) },
    });
    if (!store)
        throw new NotFoundException("Không tìm thấy cửa hàng.");
    return store;
}
export const safeStore = (s: any) => {
    const { credentials, fingerprint, ...rest } = s;
    return rest;
};
export async function createStore(userId: string, body: unknown) {
    const input = z
        .object({
        name: z.string().trim().min(2).max(80),
        platform: z.enum(["wb", "ozon"]),
        apiKey: z.string().max(10000).default(""),
        clientId: z.string().max(30).optional(),
        demo: z.boolean().default(false),
    })
        .parse(body);
    if (input.demo && env.NODE_ENV !== "test")
        throw new BadRequestException("Vui lòng kết nối cửa hàng bằng thông tin của sàn.");
    if (!input.demo &&
        (!input.apiKey ||
            (input.platform === "ozon" && !/^\d+$/.test(input.clientId || ""))))
        throw new BadRequestException("Nhập API key và Client ID hợp lệ.");
    const fingerprint = digest(input.demo
        ? `demo:${userId}:${input.platform}`
        : `${input.platform}:${input.platform === "ozon" ? input.clientId : input.apiKey}`);
    const existing = await db.store.findFirst({
        where: { userId, platform: input.platform, fingerprint },
    });
    if (existing)
        throw new ConflictException("Cửa hàng này đã được kết nối.");
    const store = await db.$transaction(async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const created = await tx.store.create({
            data: {
                userId,
                name: input.name,
                platform: input.platform,
                credentials: encrypt({ apiKey: input.apiKey, clientId: input.clientId }),
                fingerprint,
                demo: input.demo,
            },
        });
        await tx.task.create({ data: { storeId: created.id, kind: "sync", payload: {
                    // Ozon's initial prices (including old_price) are mandatory even if an
                    // older account configuration only selected catalog.
                    initialization: input.platform === "ozon" ? ["catalog", "pricing", ...automationSettings(user.automation).initialization.filter(s => s !== "catalog" && s !== "pricing")] : automationSettings(user.automation).initialization,
                    initializationGuard: automationSettings(user.automation).initializationGuard,
                } } });
        return created;
    });
    return safeStore(store);
}
// PostgreSQL task table is a durable outbox. Workers dispatch it to BullMQ.
// A Redis outage never loses an accepted user request.
export async function enqueue(storeId: string, kind: string, payload: any = {}) {
    return db.task.create({ data: { storeId, kind, payload } });
}
