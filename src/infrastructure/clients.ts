import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { env } from "../config/env";
export const db = new PrismaClient();
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const taskQueueName = env.NODE_ENV === "test" ? "marketplace-test-tasks" : "marketplace-tasks";
export const queue = new Queue(taskQueueName, {
    connection: redis as any,
    defaultJobOptions: {
        removeOnComplete: { age: 604800, count: 10000 },
        removeOnFail: { age: 2592000 },
    },
});
export async function notify(userId: string, title: string, body: string, level = "info") {
    const item = await db.notification.create({
        data: { userId, title, body, level },
    });
    // Realtime is best-effort; the persisted inbox is still available via polling.
    await redis.publish(`events:${userId}`, JSON.stringify(item)).catch(() => { });
    return item;
}
