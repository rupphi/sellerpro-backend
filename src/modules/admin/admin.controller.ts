import { Body, Controller, Get, Patch, Param, Req, UseGuards, HttpException } from "@nestjs/common";
import { z } from "zod";
import { db } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { automationSchema, automationSettings } from "../automation/automation.policy";
import { AdminGuard } from "../auth/admin.guard";
@Controller("api")
export class AdminController {
    @UseGuards(AuthGuard, AdminGuard)
    @Get("admin/accounts")
    async adminAccounts() {
        return db.user.findMany({ orderBy: { username: "asc" }, select: {
                id: true, username: true, role: true, _count: { select: { stores: true } },
            } });
    }
    @UseGuards(AuthGuard, AdminGuard)
    @Get("admin/accounts/:userId/automation")
    async adminAutomation(
    @Param("userId")
    id: string) {
        const user = await db.user.findUnique({ where: { id }, select: { automation: true, automationUpdatedAt: true } });
        if (!user)
            throw new HttpException("Không tìm thấy tài khoản.", 404);
        return { settings: automationSettings(user.automation), updatedAt: user.automationUpdatedAt };
    }
    // Compatibility route remains admin-only; never permits a seller to bypass RBAC.
    @UseGuards(AuthGuard, AdminGuard)
    @Patch("automation")
    async saveOwnAutomation(
    @Req()
    r: AuthedRequest, 
    @Body()
    body: unknown) {
        return this.saveAutomation(r.userId, body);
    }
    @UseGuards(AuthGuard, AdminGuard)
    @Patch("admin/accounts/:userId/automation")
    async saveAutomation(
    @Param("userId")
    userId: string, 
    @Body()
    body: unknown) {
        const input = z.object({ settings: automationSchema, updatedAt: z.string().datetime().nullable() }).strict().parse(body);
        return db.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`automation:${userId}`}))::text`;
            const user = await tx.user.findUnique({ where: { id: userId } });
            if (!user)
                throw new HttpException("Không tìm thấy tài khoản.", 404);
            if ((user.automationUpdatedAt?.toISOString() || null) !== input.updatedAt)
                throw new HttpException("Lịch đã thay đổi ở cửa sổ khác. Tải lại trước khi lưu.", 409);
            const updatedAt = new Date();
            const updated = await tx.user.update({ where: { id: userId }, data: {
                    automation: input.settings, automationUpdatedAt: updatedAt,
                } });
            // Running work can finish; queued automatic work from the old schedule cannot start.
            await tx.task.updateMany({ where: {
                    store: { userId }, scheduleKey: { not: null }, status: { in: ["queued", "retrying"] },
                }, data: { status: "cancelled", finishedAt: updatedAt } });
            return { settings: automationSettings(updated.automation), updatedAt };
        });
    }
}
