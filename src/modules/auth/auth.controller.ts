import { Body, Controller, Get, Post, Req, Res, UseGuards, BadRequestException, UnauthorizedException, HttpException } from "@nestjs/common";
import { Response, Request } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, redis } from "../../infrastructure/clients";
import { hashPassword, checkPassword, digest } from "../../common/security";
import { AuthGuard, AuthedRequest } from "./auth.guard";
import { env } from "../../config/env";
import { SESSION_COOKIE, sessionCookieOptions } from "./session-cookie";
const loginSchema = z.object({
    username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9_.-]{3,40}$/),
    password: z.string().min(6, "Mật khẩu cần ít nhất 6 ký tự.").max(128),
}).strict();
@Controller("api")
export class AuthController {
    @Post("auth/register")
    async register(
    @Body()
    body: unknown, 
    @Req()
    req: Request, 
    @Res({ passthrough: true })
    res: Response) {
        await this.limit(req);
        const input = loginSchema.parse(body);
        if (await db.user.findUnique({ where: { username: input.username } }))
            throw new BadRequestException("Tên đăng nhập đã được sử dụng.");
        const user = await db.user.create({
            data: {
                username: input.username,
                passwordHash: await hashPassword(input.password),
            },
        });
        await this.session(user.id, res);
        return { id: user.id, username: user.username, role: user.role };
    }
    @Post("auth/login")
    async login(
    @Body()
    body: unknown, 
    @Req()
    req: Request, 
    @Res({ passthrough: true })
    res: Response) {
        await this.limit(req);
        const input = loginSchema.parse(body), user = await db.user.findUnique({ where: { username: input.username } });
        if (!user || !(await checkPassword(input.password, user.passwordHash)))
            throw new UnauthorizedException("Tên đăng nhập hoặc mật khẩu không đúng.");
        await this.session(user.id, res);
        return { id: user.id, username: user.username, role: user.role };
    }
    private async limit(req: Request) {
        const key = `login:${req.ip}`;
        const n = await redis.incr(key);
        if (n === 1)
            await redis.expire(key, 60);
        if (n > 12)
            throw new HttpException("Thử lại sau một phút.", 429);
    }
    private async session(userId: string, res: Response) {
        const token = randomBytes(32).toString("hex");
        await db.session.create({
            data: {
                id: digest(token),
                userId,
                expiresAt: null,
            },
        });
        res.cookie(SESSION_COOKIE, token, sessionCookieOptions(env.NODE_ENV === "production"));
    }
    @UseGuards(AuthGuard)
    @Get("auth/me")
    me(
    @Req()
    r: AuthedRequest) {
        return db.user.findUnique({
            where: { id: r.userId },
            select: { id: true, username: true, role: true },
        });
    }
    @Post("auth/logout")
    async logout(
    @Req()
    r: Request, 
    @Res({ passthrough: true })
    res: Response) {
        if (r.cookies?.[SESSION_COOKIE])
            await db.session.deleteMany({
                where: { id: digest(r.cookies[SESSION_COOKIE]) },
            });
        const { maxAge, ...options } = sessionCookieOptions(env.NODE_ENV === "production");
        res.clearCookie(SESSION_COOKIE, options);
        return { ok: true };
    }
}
