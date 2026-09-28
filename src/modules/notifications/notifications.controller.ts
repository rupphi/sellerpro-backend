import { Controller, Get, Patch, Req, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { db, redis } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
@Controller("api")
export class NotificationsController {
    @UseGuards(AuthGuard)
    @Get("notifications")
    notifications(
    @Req()
    r: AuthedRequest) {
        return db.notification.findMany({
            where: { userId: r.userId },
            orderBy: { createdAt: "desc" },
            take: 30,
        });
    }
    @UseGuards(AuthGuard)
    @Patch("notifications/read")
    async read(
    @Req()
    r: AuthedRequest) {
        await db.notification.updateMany({
            where: { userId: r.userId, readAt: null },
            data: { readAt: new Date() },
        });
        return { ok: true };
    }
    @UseGuards(AuthGuard)
    @Get("events")
    async events(
    @Req()
    req: AuthedRequest, 
    @Res()
    res: Response) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        const sub = redis.duplicate();
        await sub.subscribe(`events:${req.userId}`);
        sub.on("message", (_, message) => res.write(`data: ${message}\n\n`));
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 20000);
        req.on("close", () => {
            clearInterval(timer);
            sub.disconnect();
        });
    }
}
