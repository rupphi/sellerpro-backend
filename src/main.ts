import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { json } from "express";
import { AppModule } from "./app.module";
import { Errors } from "./common/http-errors.filter";
import { env } from "./config/env";
import { db, redis, queue } from "./infrastructure/clients";
async function main() {
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    // Only enable for a private listener behind our trusted reverse proxy.
    app.getHttpAdapter().getInstance().set("trust proxy", env.TRUST_PROXY_HOPS);
    app.use(helmet(), cookieParser(), json({ limit: "1mb" }));
    app.use((req: any, res: any, next: any) => {
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
            req.headers.origin &&
            req.headers.origin !== env.APP_ORIGIN)
            return res.status(403).json({ message: "Origin không hợp lệ." });
        next();
    });
    app.useGlobalFilters(new Errors());
    app.enableShutdownHooks();
    await app.listen(env.PORT, env.HOST);
    const close = async () => {
        await app.close();
        await queue.close();
        await redis.quit();
        await db.$disconnect();
        process.exit(0);
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
}
main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
