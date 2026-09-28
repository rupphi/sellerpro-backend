import { BadRequestException, ConflictException } from "@nestjs/common";
import { z } from "zod";
import { db } from "../../infrastructure/clients";
import { changesSchema } from "./pricing.domain";
import { ownedStore, enqueue } from "../stores/stores.service";
export async function validateChanges(userId: string, storeId: string, input: unknown) {
    const store = await ownedStore(userId, storeId);
    const changes = changesSchema.parse(input);
    const products = await db.product.findMany({
        where: { storeId, id: { in: changes.map((x) => x.id) } },
    });
    for (const change of changes) {
        const product = products.find((x) => x.id === change.id);
        if (!product)
            throw new BadRequestException("Sản phẩm không thuộc cửa hàng.");
        if (product.version !== change.version)
            throw new ConflictException(`Giá của ${product.article} đã thay đổi. Tải lại trước khi lưu.`);
        if (product.currency !== "RUB")
            throw new BadRequestException("Phiên bản này chỉ hỗ trợ chỉnh giá RUB.");
        if (store.platform === "wb" &&
            (change.price % 100 || (product.raw as any).sizePricing))
            throw new BadRequestException("WB: giá phải là rúp nguyên và không có giá riêng theo size.");
        if (store.platform === "ozon" && change.discount !== 0)
            throw new BadRequestException("Ozon: chỉnh trực tiếp giá bán, không nhập phần trăm giảm giá.");
    }
    return changes;
}
export async function submitChanges(userId: string, storeId: string, input: unknown, preserveLocks = false) {
    const changes = await validateChanges(userId, storeId, input);
    return enqueue(storeId, "prices", { changes, preserveLocks });
}
export async function submitLocks(userId: string, storeId: string, body: unknown) {
    await ownedStore(userId, storeId);
    const input = z
        .discriminatedUnion("scope", [
        z.object({ scope: z.literal("all"), locked: z.boolean() }).strict(),
        z
            .object({
            scope: z.literal("product"),
            productId: z.string().uuid(),
            locked: z.boolean(),
        })
            .strict(),
    ])
        .parse(body);
    // Snapshot the scope: products arriving in a later sync are not silently included.
    const products = await db.product.findMany({
        where: {
            storeId,
            ...(input.scope === "product" ? { id: input.productId } : {}),
        },
        select: { id: true },
    });
    if (!products.length)
        throw new BadRequestException("Không tìm thấy sản phẩm trong cửa hàng.");
    return enqueue(storeId, "locks", {
        locked: input.locked,
        productIds: products.map((p) => p.id),
    });
}
