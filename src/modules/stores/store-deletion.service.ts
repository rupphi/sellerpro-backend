import { BadRequestException, ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, redis } from "../../infrastructure/clients";
import { ownedStore } from "./stores.service";
/** Local deletion only. Never calls a marketplace adapter. */
export async function deleteStore(userId: string, id: string, body: unknown) {
    const { confirmName } = z.object({ confirmName: z.string() }).strict().parse(body);
    const store = await ownedStore(userId, id);
    if (confirmName !== store.name)
        throw new BadRequestException("Tên xác nhận chưa khớp với cửa hàng.");
    const key = `account-lock:${store.fingerprint}`, token = randomUUID();
    if (!(await redis.set(key, token, "PX", 90000, "NX")))
        throw new ConflictException("Cửa hàng đang xử lý tác vụ. Vui lòng chờ hoàn tất rồi xóa.");
    try {
        await db.$transaction(async (tx) => {
            // Coordinate with scheduler/settings saves. Existing queued jobs later become no-ops.
            await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`automation:${userId}`}))::text`;
            if (await tx.task.count({ where: { storeId: id, status: "running" } }))
                throw new ConflictException("Cửa hàng còn tác vụ đang chạy hoặc cần kiểm tra. Chưa thể xóa.");
            await tx.store.delete({ where: { id, userId } });
        });
        return { ok: true };
    }
    finally {
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, token);
    }
}
