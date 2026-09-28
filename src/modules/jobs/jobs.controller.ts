import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { db } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { ownedStore } from "../stores/stores.service";
@Controller("api")
export class JobsController {
    @UseGuards(AuthGuard)
    @Get("stores/:id/tasks")
    async tasks(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string) {
        await ownedStore(r.userId, id);
        return db.task.findMany({
            where: { storeId: id },
            orderBy: { createdAt: "desc" },
            take: 30,
            omit: { payload: true },
        });
    }
    @UseGuards(AuthGuard)
    @Get("stores/:id/audit")
    async audit(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string) {
        await ownedStore(r.userId, id);
        const entries = await db.audit.findMany({
            where: { storeId: id },
            orderBy: { createdAt: "desc" },
            take: 100,
        });
        const products = await db.product.findMany({
            where: {
                storeId: id,
                id: { in: entries.flatMap((x) => (x.productId ? [x.productId] : [])) },
            },
            select: { id: true, article: true },
        });
        return entries.map((entry) => ({
            ...entry,
            article: products.find((p) => p.id === entry.productId)?.article || null,
        }));
    }
}
