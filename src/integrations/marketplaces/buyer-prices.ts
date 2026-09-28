/** Historical transaction prices only. Never feed these values into price protection. */
export type BuyerPrice = {
    customerPrice: number | null;
    discountPercent: number | null;
    discountKind: "reported" | "price_difference";
    currency: string;
    transactionAt: string;
    collectedAt: string;
    source: "wb_sale" | "ozon_fbs" | "ozon_fbo";
};
export type BuyerPriceRow = {
    key: string;
    value: BuyerPrice;
};
export type BuyerPriceResult = {
    rows: BuyerPriceRow[];
    partial: boolean;
};
export const LOOKBACK_DAYS = 30;
export function amount(value: unknown): number | null {
    if (value === null ||
        value === undefined ||
        value === "" ||
        typeof value === "boolean")
        return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 && n <= 10000000
        ? Math.round(n * 100)
        : null;
}
function percent(value: unknown): number | null {
    if (value === null ||
        value === undefined ||
        value === "" ||
        typeof value === "boolean")
        return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}
function timestamp(value: unknown, moscow = false): string | null {
    if (typeof value !== "string" || !value)
        return null;
    const zoned = moscow && !/(Z|[+-]\d\d:\d\d)$/i.test(value) ? value + "+03:00" : value;
    const t = Date.parse(zoned);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function within(at: string | null, now: Date): at is string {
    return (!!at &&
        Date.parse(at) >= now.getTime() - LOOKBACK_DAYS * 86400000 &&
        Date.parse(at) <= now.getTime());
}
export function latest(rows: BuyerPriceRow[]): BuyerPriceRow[] {
    const map = new Map<string, BuyerPriceRow>();
    for (const row of rows) {
        const old = map.get(row.key);
        if (!old || row.value.transactionAt > old.value.transactionAt)
            map.set(row.key, row);
    }
    return [...map.values()];
}
export function wbSales(rows: any[], now = new Date()): BuyerPriceRow[] {
    return latest(rows.flatMap((row) => {
        const at = timestamp(row.date, true);
        if (!String(row.saleID || "").startsWith("S") ||
            !row.nmId ||
            !within(at, now))
            return [];
        const customerPrice = amount(row.finishedPrice);
        return [
            {
                key: String(row.nmId),
                value: {
                    customerPrice,
                    // A zero price may be a pending financial calculation, never a free sale.
                    discountPercent: customerPrice === null ? null : percent(row.spp),
                    discountKind: "reported" as const,
                    currency: "RUB",
                    transactionAt: at,
                    collectedAt: now.toISOString(),
                    source: "wb_sale" as const,
                },
            },
        ];
    }));
}
export function ozonPostings(rows: any[], source: "ozon_fbs" | "ozon_fbo", now = new Date()): BuyerPriceRow[] {
    return latest(rows.flatMap((posting) => {
        const at = timestamp(posting.in_process_at || posting.created_at);
        if (posting.status !== "delivered" || !within(at, now))
            return [];
        return (posting.products || []).flatMap((product: any) => {
            if (!product.offer_id || !product.sku)
                return [];
            // Financial product_id is a SKU, NOT the catalog product_id. Match by SKU then offer_id.
            const matches = (posting.financial_data?.products || []).filter((x: any) => String(x.product_id) === String(product.sku));
            const financial = matches.length === 1 ? matches[0] : undefined;
            const currency = financial?.customer_currency_code;
            const customerPrice = typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
                ? amount(financial?.customer_price)
                : null;
            const sellerPrice = amount(financial?.price);
            const comparable = customerPrice !== null &&
                sellerPrice !== null &&
                currency === financial.currency_code &&
                customerPrice <= sellerPrice;
            return [
                {
                    key: String(product.offer_id),
                    value: {
                        customerPrice,
                        // This is an explicitly labelled price difference, not total_discount_percent
                        // (which includes seller-funded promotions), nor a claim about Ozon funding.
                        discountPercent: comparable
                            ? Math.round((1 - customerPrice! / sellerPrice!) * 10000) / 100
                            : null,
                        discountKind: "price_difference" as const,
                        currency: customerPrice === null ? "RUB" : currency,
                        transactionAt: at,
                        collectedAt: now.toISOString(),
                        source,
                    },
                },
            ];
        });
    }));
}
export async function fetchWbSales(call: (host: string, path: string) => Promise<any>, now = new Date()): Promise<BuyerPriceResult> {
    let cursor = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
    const rows: BuyerPriceRow[] = [];
    for (let page = 0; page < 20; page++) {
        const response = await call("statistics-api", `/api/v1/supplier/sales?dateFrom=${encodeURIComponent(cursor)}&flag=0`);
        if (!Array.isArray(response))
            throw new Error("Unexpected WB sales response");
        if (!response.length)
            return { rows: latest(rows), partial: false };
        rows.push(...wbSales(response, now));
        // WB documents a conditional page size: continue until the empty page, not length<80000.
        const next = response.at(-1)?.lastChangeDate;
        if (!timestamp(next, true) || next === cursor)
            throw new Error("WB sales cursor stalled");
        cursor = next;
    }
    throw new Error("WB sales pagination limit reached");
}
export async function fetchOzonSales(call: (path: string, body: unknown) => Promise<any>, now = new Date()): Promise<BuyerPriceResult> {
    const rows: BuyerPriceRow[] = [];
    let partial = false;
    let completed = 0;
    for (const [path, source] of [
        ["/v3/posting/fbs/list", "ozon_fbs"],
        ["/v2/posting/fbo/list", "ozon_fbo"],
    ] as const) {
        try {
            const channel: BuyerPriceRow[] = [];
            let done = false;
            for (let offset = 0; offset < 20000; offset += 1000) {
                const response = await call(path, {
                    dir: "DESC",
                    filter: {
                        since: new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString(),
                        to: now.toISOString(),
                        status: "delivered",
                    },
                    limit: 1000,
                    offset,
                    with: { financial_data: true, analytics_data: false },
                });
                const postings = source === "ozon_fbs" ? response.result?.postings : response.result;
                if (!Array.isArray(postings))
                    throw new Error("Unexpected Ozon postings response");
                channel.push(...ozonPostings(postings, source, now));
                if (postings.length < 1000 && response.result?.has_next !== true) {
                    done = true;
                    break;
                }
                if (!postings.length)
                    throw new Error("Ozon postings pagination stalled");
            }
            if (!done)
                throw new Error("Ozon postings pagination limit reached");
            rows.push(...channel);
            completed++;
        }
        catch {
            partial = true;
        }
    }
    if (!completed)
        throw new Error("Không đọc được giá giao dịch Ozon. Kiểm tra quyền đọc đơn hàng.");
    return { rows: latest(rows), partial };
}
