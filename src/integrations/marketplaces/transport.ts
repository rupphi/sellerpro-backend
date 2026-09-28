import { redis } from "../../infrastructure/clients";
import { parseFinanceJson } from "./finance-json";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Shared across worker processes and all stores using the same marketplace account.
export async function reserveSlot(key: string, intervalMs: number) {
    for (;;) {
        const wait = Number(await redis.eval(`local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); local next=tonumber(redis.call('GET',KEYS[1]) or '0'); if next>now then return next-now end; redis.call('SET',KEYS[1],now+ARGV[1],'PX',ARGV[1]); return 0`, 1, `rate:${key}`, intervalMs));
        if (!wait)
            return;
        await sleep(Math.min(wait + Math.random() * 80, 60000));
    }
}
export async function request(account: string, url: string, headers: Record<string, string>, body?: unknown, method = body === undefined ? "GET" : "POST") {
    for (let attempt = 0; attempt < 4; attempt++) {
        const target = new URL(url);
        const finance = target.hostname === "finance-api.wildberries.ru";
        if (finance) await reserveSlot(`${account}:wb-finance`, 61000);
        if (target.hostname === "statistics-api.wildberries.ru" && ["/api/v1/supplier/sales", "/api/v1/supplier/orders"].includes(target.pathname)) {
            await reserveSlot(`${account}:wb-${target.pathname.endsWith("sales") ? "sales" : "orders"}`, 61000);
        }
        if (target.hostname === "seller-analytics-api.wildberries.ru" && target.pathname.includes("/sales-funnel/"))
            await reserveSlot(`${account}:wb-funnel`, 21000);
        await reserveSlot(account, 1200);
        const response = await fetch(url, {
            method,
            headers: { ...headers, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
        if (response.status === 429) {
            const retry = response.headers.get("Retry-After");
            const retryMs = retry
                ? Number.isFinite(Number(retry))
                    ? Number(retry) * 1000
                    : Date.parse(retry) - Date.now()
                : NaN;
            const delay = Math.ceil(Math.max(5000, Number.isFinite(retryMs) ? retryMs : 15000 * (attempt + 1)));
            await redis.set(`rate:${account}`, Date.now() + delay, "PX", delay);
            await sleep(Math.min(delay, 60000));
            continue;
        }
        // No blind transport retry after an ambiguous write or timeout.
        if (!response.ok) {
            console.error('Marketplace request failed', response.status, new URL(url).pathname);
            if (finance) throw new Error(response.status === 401 || response.status === 403 ? "Chưa đọc được quyết toán. Kiểm tra quyền Tài chính của khóa truy cập và phạm vi hỗ trợ của sàn." : "Chưa lấy được báo cáo tài chính. Vui lòng thử lại sau.");
            throw new Error(response.status === 401 || response.status === 403 ? 'Không kết nối được cửa hàng. Vui lòng kiểm tra khóa truy cập và quyền quản lý sản phẩm.' : 'Sàn chưa chấp nhận yêu cầu. Vui lòng kiểm tra thông tin sản phẩm và thử lại.');
        }
        if (response.status === 204) return null;
        return finance ? parseFinanceJson(await response.text()) as any : await response.json() as any;
    }
    throw new Error("Sàn đang bận. Yêu cầu của bạn sẽ được kiểm tra lại.");
}
