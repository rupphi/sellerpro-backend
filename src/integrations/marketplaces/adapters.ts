import type { Product, Store } from "@prisma/client";
import { decrypt } from "../../common/security";
import { CatalogItem, effective, money, rubles } from "../../modules/pricing/pricing.domain";
import { request } from "./transport";
import { env } from "../../config/env";
import { fetchOzonSales, fetchWbSales, BuyerPriceResult } from "./buyer-prices";
export interface Adapter {
    catalog(progress: (p: number) => Promise<void>, metadataOnly?: boolean): Promise<CatalogItem[]>;
    hydratePrices?(items: CatalogItem[], progress: (p: number) => Promise<void>): Promise<CatalogItem[]>;
    buyerPrices(): Promise<BuyerPriceResult>;
    write(product: Product, price: number, discount: number, locked: boolean): Promise<void>;
}
export function adapter(store: Store): Adapter {
    if (store.demo) {
        if (env.NODE_ENV !== "test")
            throw new Error("Cửa hàng thử nghiệm đã ngừng hoạt động.");
        return new DemoAdapter(store.platform);
    }
    const credentials = decrypt(store.credentials);
    return store.platform === "ozon"
        ? new OzonAdapter(store.fingerprint, credentials)
        : new WbAdapter(store.fingerprint, credentials.apiKey);
}
export class OzonAdapter implements Adapter {
    constructor(private account: string, private creds: {
        apiKey: string;
        clientId?: string;
    }) { }
    call(path: string, body?: unknown) {
        return request(this.account, `https://api-seller.ozon.ru${path}`, { "Client-Id": this.creds.clientId!, "Api-Key": this.creds.apiKey }, body);
    }
    buyerPrices() {
        return fetchOzonSales((path, body) => this.call(path, body));
    }
    private async priceRows(progress: (p: number) => Promise<void>) {
        const prices: any[] = [];
        const seen = new Set<string>();
        let cursor = "";
        for (let page = 0; page < 10000; page++) {
            const res = await this.call("/v5/product/info/prices", {
                filter: { visibility: "ALL" },
                limit: 1000,
                cursor,
            });
            if (!Array.isArray(res.items) || !Number.isInteger(res.total) || res.total < 0) throw new Error("Ozon chưa trả đủ danh sách giá.");
            for (const item of res.items) {
                const id = String(item.product_id);
                if (seen.has(id)) throw new Error("Danh sách giá Ozon bị trùng.");
                seen.add(id);
            }
            prices.push(...res.items);
            await progress(Math.min(65, Math.round((prices.length / Math.max(res.total, 1)) * 65)));
            if (prices.length >= res.total) return prices;
            if (!res.items.length) throw new Error("Danh sách giá Ozon chưa đầy đủ.");
            if (!res.cursor || res.cursor === cursor)
                throw new Error("Ozon pagination stalled");
            cursor = res.cursor;
        }
        throw new Error("Chưa đọc hết danh sách giá Ozon.");
    }
    private priceFields(p: any) {
        if (!p || p.price == null) throw new Error("Sản phẩm Ozon chưa có dữ liệu giá.");
        return { price: money(p.price), discount: 0, salePrice: money(p.marketing_seller_price ?? p.price), oldPrice: money(p.old_price || 0), minPrice: money(p.min_price || 0), currency: p.currency_code || "RUB" };
    }
    async hydratePrices(items: CatalogItem[], progress: (p: number) => Promise<void>) {
        const rows = new Map((await this.priceRows(progress)).map(row => [String(row.product_id), row]));
        return items.map(item => {
            const row = rows.get(item.externalId);
            if (!row) throw new Error("Danh mục Ozon thay đổi trong lúc đồng bộ. Vui lòng đồng bộ lại.");
            return { ...item, ...this.priceFields(row.price), raw: { ...item.raw, autoAction: row.price.auto_action_enabled, autoAdd: row.price.auto_add_to_ozon_actions_list_enabled, ozonActions: row.marketing_actions?.ozon_actions_exist, priceStrategy: "unknown" } };
        });
    }
    async catalog(progress: (p: number) => Promise<void>, metadataOnly = false) {
        let prices: any[];
        if (!metadataOnly) prices = await this.priceRows(progress);
        else {
            prices = [];
            let cursor = "", complete = false;
            const seen = new Set<string>();
            for (let page = 0; page < 10000; page++) {
                const res = (await this.call("/v3/product/list", { filter: { visibility: "ALL" }, last_id: cursor, limit: 1000 })).result;
                if (!Array.isArray(res?.items) || !Number.isInteger(res.total) || res.total < 0) throw new Error("Ozon chưa trả đủ danh mục.");
                for (const row of res.items) {
                    const id = String(row.product_id);
                    if (seen.has(id)) throw new Error("Danh mục Ozon bị trùng.");
                    seen.add(id); prices.push(row);
                }
                await progress(Math.min(40, Math.round(prices.length / Math.max(1, res.total) * 40)));
                if (prices.length >= res.total) { complete = true; break; }
                if (!res.items.length || !res.last_id || res.last_id === cursor) throw new Error("Danh mục Ozon chưa được đọc hết.");
                cursor = res.last_id;
            }
            if (!complete) throw new Error("Chưa đọc hết danh mục Ozon.");
        }
        const categories = new Map<number, string>();
        try {
            const tree = await this.call("/v1/description-category/tree", {
                language: "DEFAULT",
            });
            const walk = (nodes: any[]) => {
                for (const node of nodes) {
                    if (node.description_category_id)
                        categories.set(node.description_category_id, node.category_name);
                    if (node.type_id)
                        categories.set(node.type_id, node.type_name);
                    walk(node.children || []);
                }
            };
            walk(tree.result || []);
        }
        catch {
            /* Category permission is optional; IDs stay visible when unavailable. */
        }
        const result: CatalogItem[] = [];
        for (let i = 0; i < prices.length; i += 100) {
            const batch = prices.slice(i, i + 100);
            const info = await this.call("/v3/product/info/list", {
                product_id: batch.map((x) => x.product_id),
            });
            if (!Array.isArray(info.items)) throw new Error("Chưa đọc được thông tin sản phẩm Ozon.");
            let attributes: any[] = [];
            try {
                const response = await this.call("/v4/product/info/attributes", {
                    filter: {
                        product_id: batch.map((x) => x.product_id),
                        visibility: "ALL",
                    },
                    limit: 100,
                    sort_dir: "ASC",
                });
                attributes = response.result || [];
            }
            catch {
                /* Price sync remains usable without the Content permission. */
            }
            for (const row of batch) {
                const detail = info.items.find((x: any) => String(x.id) === String(row.product_id));
                if (!detail) throw new Error("Ozon chưa trả đủ thông tin sản phẩm.");
                const attr = attributes.find((x) => String(x.id) === String(row.product_id));
                const p = row.price;
                result.push({
                    externalId: String(row.product_id),
                    article: row.offer_id,
                    title: detail.name || row.offer_id,
                    brand: attr?.attributes?.find((x: any) => x.id === 85)?.values?.[0]
                        ?.value || "",
                    category: categories.get(detail.type_id) ||
                        categories.get(detail.description_category_id) ||
                        (detail.description_category_id
                            ? `Danh mục ${detail.description_category_id}`
                            : "Chưa phân loại"),
                    image: detail.primary_image?.[0] || detail.images?.[0] || "",
                    ...(metadataOnly ? { price: 0, discount: 0, salePrice: 0, oldPrice: 0, minPrice: 0, currency: "RUB" } : this.priceFields(p)),
                    stock: detail.stocks?.stocks
                        ? detail.stocks.stocks.reduce((s: number, x: any) => s + (x.present || 0), 0)
                        : null,
                    raw: {
                        autoAction: p?.auto_action_enabled,
                        autoAdd: p?.auto_add_to_ozon_actions_list_enabled,
                        ozonActions: row.marketing_actions?.ozon_actions_exist,
                        priceStrategy: "unknown",
                        details: detail,
                    },
                });
            }
            await progress(65 +
                Math.round((Math.min(i + 100, prices.length) / Math.max(prices.length, 1)) *
                    25));
        }
        return result;
    }
    async write(product: Product, price: number, discount: number, locked: boolean) {
        const final = effective(price, discount);
        const res = await this.call("/v1/product/import/prices", {
            prices: [
                {
                    product_id: Number(product.externalId),
                    price: rubles(final),
                    old_price: product.oldPrice > final ? rubles(product.oldPrice) : "0",
                    ...(locked
                        ? {
                            min_price: rubles(Math.max(final, product.minPrice)),
                            min_price_for_auto_actions_enabled: true,
                            auto_action_enabled: "DISABLED",
                            price_strategy_enabled: "DISABLED",
                        }
                        : {}),
                },
            ],
        });
        const row = res.result?.find((x: any) => String(x.product_id) === product.externalId);
        if (!row?.updated || row.errors?.length)
            throw new Error(`Ozon chưa chấp nhận giá ${product.article}: ${row?.errors?.map((x: any) => x.code).join(", ") || "unknown"}`);
    }
}
export class WbAdapter implements Adapter {
    constructor(private account: string, private apiKey: string) { }
    call(host: string, path: string, body?: unknown) {
        return request(this.account, `https://${host}.wildberries.ru${path}`, { Authorization: this.apiKey }, body);
    }
    buyerPrices() {
        return fetchWbSales((host, path) => this.call(host, path));
    }
    async catalog(progress: (p: number) => Promise<void>) {
        const cards = new Map<string, any>();
        let cursor: any = { limit: 100 };
        for (let page = 0; page < 10000; page++) {
            const data = await this.call("content-api", "/content/v2/get/cards/list", { settings: { cursor, filter: { withPhoto: -1 } } });
            for (const row of data.cards || [])
                cards.set(String(row.nmID), row);
            if (!data.cards?.length || data.cursor?.total < 100)
                break;
            const next = {
                limit: 100,
                updatedAt: data.cursor.updatedAt,
                nmID: data.cursor.nmID,
            };
            if (JSON.stringify(next) === JSON.stringify(cursor))
                throw new Error("WB pagination stalled");
            cursor = next;
        }
        await progress(45);
        const result: CatalogItem[] = [];
        for (let offset = 0;; offset += 1000) {
            const data = await this.call("discounts-prices-api", `/api/v2/list/goods/filter?limit=1000&offset=${offset}`);
            const goods = data.data?.listGoods || [];
            for (const row of goods) {
                const card = cards.get(String(row.nmID)) || {}, size = row.sizes?.[0];
                if (!size)
                    continue;
                result.push({
                    externalId: String(row.nmID),
                    article: card.vendorCode || row.vendorCode || "",
                    title: card.title || card.vendorCode || String(row.nmID),
                    brand: card.brand || "",
                    category: card.subjectName || "Chưa phân loại",
                    image: card.photos?.[0]?.big || "",
                    price: money(size.price),
                    discount: row.discount || 0,
                    salePrice: money(size.discountedPrice),
                    minPrice: 0,
                    oldPrice: 0,
                    currency: row.currencyIsoCode4217 || "RUB",
                    stock: null,
                    raw: {
                        sizePricing: Boolean(row.editableSizePrice),
                        sizes: row.sizes,
                    },
                });
            }
            if (goods.length < 1000)
                break;
        }
        await progress(90);
        return result;
    }
    async write(product: Product, price: number, discount: number) {
        if ((product.raw as any).sizePricing)
            throw new Error("Sản phẩm có giá theo kích cỡ. Cần cập nhật từng size trong WB Seller.");
        if (price % 100 !== 0)
            throw new Error("WB yêu cầu giá theo rúp nguyên.");
        const current = await this.call("discounts-prices-api", `/api/v2/list/goods/filter?limit=1&offset=0&filterNmID=${product.externalId}`);
        const observed = current.data?.listGoods?.find((p: any) => String(p.nmID) === product.externalId);
        if (!observed?.sizes?.length)
            throw new Error("Chưa đọc được giá hiện tại. Vui lòng đồng bộ lại.");
        if (observed.editableSizePrice)
            throw new Error("Sản phẩm có giá theo kích cỡ. Vui lòng chỉnh trong Wildberries Seller.");
        // Enabling monitoring at the current price must not submit a redundant upload.
        if (observed.discount === discount &&
            observed.sizes.every((s: any) => money(s.price) === price))
            return;
        const data = await this.call("discounts-prices-api", "/api/v2/upload/task", {
            data: [
                { nmID: Number(product.externalId), price: price / 100, discount },
            ],
        });
        if (data.error)
            throw new Error("WB từ chối tác vụ giá.");
        if (!data.data?.id)
            throw new Error("Sàn chưa xác nhận yêu cầu cập nhật. Vui lòng kiểm tra lại.");
        for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise((r) => setTimeout(r, 2500));
            const history = await this.call("discounts-prices-api", `/api/v2/history/tasks?uploadID=${data.data.id}`);
            if (history.data?.status >= 3) {
                const details = await this.call("discounts-prices-api", `/api/v2/history/goods/task?uploadID=${data.data.id}&limit=1000&offset=0`);
                const rows = details.data?.historyGoods?.filter((p: any) => String(p.nmID) === product.externalId);
                if (!rows?.length || rows.some((p: any) => p.errorText))
                    throw new Error("Wildberries chưa áp dụng giá. Vui lòng kiểm tra chương trình khuyến mại của sản phẩm.");
                return;
            }
        }
        throw new Error("Wildberries đang xử lý giá. Vui lòng đồng bộ để kiểm tra trước khi gửi lại.");
    }
}
export class DemoAdapter implements Adapter {
    constructor(private platform: string = "wb") { }
    async buyerPrices(): Promise<BuyerPriceResult> { return { rows: [], partial: false }; }
    async catalog(progress: (p: number) => Promise<void>) {
        await progress(45);
        return Array.from({ length: 18 }, (_, i): CatalogItem => ({
            externalId: String(1584280484 + i),
            article: ["2067.xiatoi", "2022.be", "2088.den", "2072.den", "RW511", "RW516"][i % 6] + (i > 5 ? `-${i}` : ""),
            title: [
                "Quần âu ống suông cạp cao",
                "Áo khoác dáng rộng mùa thu",
                "Quần jeans ống đứng",
                "Áo blazer phong cách tối giản",
                "Quần short nữ lưng cao",
                "Áo khoác nhẹ có thắt eo",
            ][i % 6],
            brand: i % 2 ? "Winstyle" : "FASHION 67",
            category: [
                "Quần âu",
                "Áo khoác",
                "Jeans",
                "Blazer",
                "Quần short",
                "Áo khoác",
            ][i % 6],
            image: `/products/product-${i % 6}.svg`,
            price: (3200 + i * 50) * 100,
            discount: this.platform === "wb" && i % 3 === 0 ? 10 : 0,
            salePrice: effective((3200 + i * 50) * 100, this.platform === "wb" && i % 3 === 0 ? 10 : 0),
            minPrice: 0,
            oldPrice: 0,
            currency: "RUB",
            stock: i % 5 === 0 ? 0 : 24 + i * 3,
            raw: {},
        }));
    }
    async write() { }
}
