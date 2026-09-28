import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request, Response } from "express";
import { db } from "../../infrastructure/clients";
import { digest } from "../../common/security";
import { env } from "../../config/env";
import { SESSION_COOKIE, sessionCookieOptions, needsSessionRenewal } from "./session-cookie";
export type AuthedRequest = Request & {
    userId: string;
};
@Injectable()
export class AuthGuard implements CanActivate {
    async canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<AuthedRequest>();
        const token = req.cookies?.[SESSION_COOKIE];
        if (!token)
            throw new UnauthorizedException("Vui lòng đăng nhập.");
        const session = await db.session.findUnique({
            where: { id: digest(token) },
        });
        const now = new Date();
        if (!session || (session.expiresAt && session.expiresAt <= now))
            throw new UnauthorizedException("Phiên đăng nhập đã hết hạn.");
        if (needsSessionRenewal(session.expiresAt, session.renewedAt, now.getTime())) {
            // Never recreate a session revoked by a concurrent logout. Old, unexpired
            // seven-day sessions become persistent on their next authenticated request.
            const renewed = await db.session.updateMany({
                where: { id: session.id, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
                data: { expiresAt: null, renewedAt: now },
            });
            if (!renewed.count)
                throw new UnauthorizedException("Vui lòng đăng nhập.");
            context.switchToHttp().getResponse<Response>().cookie(SESSION_COOKIE, token, sessionCookieOptions(env.NODE_ENV === "production"));
        }
        req.userId = session.userId;
        return true;
    }
}
