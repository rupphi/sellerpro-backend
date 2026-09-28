import { Body, Controller, Get, Post, Delete, Param, Req, UseGuards } from "@nestjs/common";
import { db } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { createStore, ownedStore, safeStore, enqueue } from "./stores.service";
import { env } from "../../config/env";
import { deleteStore } from "./store-deletion.service";
@Controller("api")
export class StoresController {
    @UseGuards(AuthGuard)
    @Get("stores")
    async stores(
    @Req()
    r: AuthedRequest) {
        return (await db.store.findMany({
            where: {
                userId: r.userId,
                ...(env.NODE_ENV === "test" ? {} : { demo: false }),
            },
            orderBy: { createdAt: "asc" },
        })).map(safeStore);
    }
    @UseGuards(AuthGuard)
    @Post("stores")
    store(
    @Req()
    r: AuthedRequest, 
    @Body()
    b: unknown) {
        return createStore(r.userId, b);
    }
    @UseGuards(AuthGuard)
    @Post("stores/:id/sync")
    async sync(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string) {
        await ownedStore(r.userId, id);
        const pending = await db.task.findFirst({
            where: {
                storeId: id,
                kind: "sync",
                status: { in: ["queued", "running", "retrying"] },
            },
        });
        return pending || enqueue(id, "sync");
    }
    @UseGuards(AuthGuard)
    @Delete("stores/:id")
    async removeStore(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @Body()
    body: unknown) {
        return deleteStore(r.userId, id, body);
    }
}
