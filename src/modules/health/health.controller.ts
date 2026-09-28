import { Controller, Get } from "@nestjs/common";
import { db, redis } from "../../infrastructure/clients";
@Controller("api")
export class HealthController {
    @Get("health")
    async health() {
        await db.$queryRaw `SELECT 1`;
        await redis.ping();
        return { status: "ok", service: "sellerpro-api" };
    }
}
