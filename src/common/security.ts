import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { env } from "../config/env";
const derive = promisify(scrypt);
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    return `${salt}:${((await derive(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function checkPassword(password: string, hash: string) {
    const [salt, expected] = hash.split(":");
    const actual = (await derive(password, salt, 64)) as Buffer;
    return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}
export function encrypt(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(env.CREDENTIALS_KEY, "hex"), iv);
    const data = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), data]
        .map((x) => x.toString("base64"))
        .join(".");
}
export function decrypt(value: string): {
    apiKey: string;
    clientId?: string;
} {
    const [iv, tag, data] = value.split(".").map((x) => Buffer.from(x, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(env.CREDENTIALS_KEY, "hex"), iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString());
}
