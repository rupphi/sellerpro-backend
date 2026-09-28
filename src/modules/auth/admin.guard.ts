import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { db } from "../../infrastructure/clients";
import type { AuthedRequest } from "./auth.guard";
/** Always used AFTER AuthGuard. Role is checked in DB, never trusted from client. */
@Injectable()
export class AdminGuard implements CanActivate {
    async canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<AuthedRequest>();
        if (!req.userId)
            throw new ForbiddenException("Chỉ tài khoản quản trị được truy cập.");
        const user = await db.user.findUnique({ where: { id: req.userId }, select: { role: true } });
        if (user?.role !== "ADMIN")
            throw new ForbiddenException("Chỉ tài khoản quản trị được truy cập.");
        return true;
    }
}
