import { z } from "zod";
// Money is stored as integer kopecks; floating point values never enter the database.
export const rubles = (kopecks: number) => (kopecks / 100).toFixed(2);
export function money(value: unknown): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 10000000)
        throw new Error("Invalid marketplace price");
    return Math.round(n * 100);
}
export const effective = (price: number, discount: number) => Math.round((price * (100 - discount)) / 100);
export const priceChange = z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    price: z.number().int().min(100).max(1000000000),
    discount: z.number().int().min(0).max(95),
    locked: z.boolean(),
});
export const changesSchema = z
    .array(priceChange)
    .min(1)
    .max(1000)
    .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, "Duplicate products");
export type PriceChange = z.infer<typeof priceChange>;
export type CatalogItem = {
    externalId: string;
    article: string;
    title: string;
    brand: string;
    category: string;
    image: string;
    price: number;
    discount: number;
    salePrice: number;
    minPrice: number;
    oldPrice: number;
    currency: string;
    stock: number | null;
    raw: any;
};
