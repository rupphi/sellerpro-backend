import { z } from "zod";
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const daily = z.object({
    enabled: z.boolean(),
    times: z.array(clock).min(1).max(24),
}).strict().superRefine(({ times }, ctx) => {
    const minutes = times.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))).sort((a, b) => a - b);
    if (minutes.some((n, i) => ((minutes[(i + 1) % minutes.length] + (i === minutes.length - 1 ? 1440 : 0)) - n) < 30))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Các giờ chạy phải cách nhau ít nhất 30 phút." });
});
export const automationSchema = z.object({
    timezone: z.string().max(80).refine(v => {
        try {
            new Intl.DateTimeFormat("en", { timeZone: v });
            return true;
        }
        catch {
            return false;
        }
    }, "Múi giờ không hợp lệ."),
    // Legacy storage key retained: now refreshes seller prices AND buyer discounts.
    buyer_prices: daily,
    catalog: daily.default({ enabled: false, times: ["07:00"] }),
    sales: daily.default({ enabled: false, times: ["09:00", "21:00"] }),
    finance: daily.default({ enabled: false, times: ["10:00"] }),
    guard: daily,
    initializationGuard: z.boolean().default(false),
    initialization: z.array(z.enum(["catalog", "pricing", "sales", "finance"])).min(1).max(4),
}).strict().superRefine((v, ctx) => {
    const order = ["catalog", "pricing", "sales", "finance"];
    if (v.initialization[0] !== "catalog" || v.initialization.some((step, i) => i > 0 && order.indexOf(step) <= order.indexOf(v.initialization[i - 1])))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Thứ tự phải là Sản phẩm → Giá cả → Phễu bán hàng → Tài chính; không lặp bước." });
    if (v.initialization.includes("sales") && !v.initialization.includes("pricing"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Chọn Giá cả trước Phễu bán hàng." });
    if (v.initializationGuard && !v.initialization.includes("pricing"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Kiểm tra bảo vệ giá thuộc bước Giá cả." });
    if (v.initialization.includes("finance") && !v.initialization.includes("pricing"))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Chọn Giá cả trước Báo cáo tài chính." });
});
export type Automation = z.infer<typeof automationSchema>;
export const DEFAULT_AUTOMATION: Automation = {
    timezone: "Asia/Ho_Chi_Minh",
    buyer_prices: { enabled: true, times: ["08:00", "20:00"] },
    guard: { enabled: true, times: ["02:00", "08:00", "14:00", "20:00"] },
    catalog: { enabled: false, times: ["07:00"] },
    sales: { enabled: false, times: ["09:00", "21:00"] },
    finance: { enabled: false, times: ["10:00"] },
    initializationGuard: false,
    initialization: ["catalog", "pricing"],
};
export function automationSettings(value: unknown): Automation {
    // Read-time migration preserves existing schedules, including paused schedules.
    const old = value as any;
    let candidate = value;
    if (old && Array.isArray(old.initialization) && old.initialization.some((s: string) => ["buyer_prices", "guard"].includes(s))) {
        candidate = { ...old, initialization: ["catalog", "pricing"], initializationGuard: old.initialization.includes("guard") };
    }
    const parsed = automationSchema.safeParse(candidate);
    return parsed.success ? parsed.data : structuredClone(DEFAULT_AUTOMATION);
}
export function defaultSalesPeriod(now = new Date()) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const day = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
    return { from: day(-7), to: day(-1), compareFrom: day(-14), compareTo: day(-8) };
}
export function defaultFinancePeriod(now = new Date()) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
    const day = (offset: number) => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
    return { from: day(-30), to: day(-1) };
}
/** Latest wall-clock slot only: missed runs coalesce, DST repeated hours run once. */
export function latestSlot(timezone: string, times: string[], now = new Date()) {
    const format = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const wanted = new Set(times);
    const minute = Math.floor(now.getTime() / 60000) * 60000;
    // 26 hours covers a local day during DST transitions, including skipped slots.
    for (let i = 0; i <= 26 * 60; i++) {
        const at = new Date(minute - i * 60000);
        const p = Object.fromEntries(format.formatToParts(at).map(x => [x.type, x.value]));
        const time = `${p.hour}:${p.minute}`;
        if (wanted.has(time))
            return { at, key: `${p.year}-${p.month}-${p.day}T${time}` };
    }
    return null;
}
