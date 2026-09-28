import { Body, Controller, Get, Post, Param, Query, Req, Res, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Response } from "express";
import { db } from "../../infrastructure/clients";
import { AuthGuard, AuthedRequest } from "../auth/auth.guard";
import { ownedStore } from "../stores/stores.service";
import { exportPrices, previewExcel } from "./excel.service";
import { submitChanges, submitLocks } from "./pricing.service";
@Controller("api")
export class PricingController {
    @UseGuards(AuthGuard)
    @Get("stores/:id/products")
    async products(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @Query()
    q: any) {
        await ownedStore(r.userId, id);
        const page = Math.max(1, Math.min(10000, Number(q.page) || 1)), limit = 30;
        const where: any = { storeId: id };
        if (q.search)
            where.OR = ["title", "article", "externalId", "brand"].map((field) => ({
                [field]: {
                    contains: String(q.search).slice(0, 200),
                    mode: "insensitive",
                },
            }));
        if (q.categories)
            where.category = { in: String(q.categories).split("|").slice(0, 100) };
        if (q.brands)
            where.brand = { in: String(q.brands).split("|").slice(0, 100) };
        if (q.stock === "true")
            where.stock = { gt: 0 };
        if (q.locked === "true")
            where.locked = true;
        if (q.noPrice === "true")
            where.price = 0;
        const [items, total, facets, stats, lockedCount] = await Promise.all([
            db.product.findMany({
                where,
                skip: (page - 1) * limit,
                take: limit,
                orderBy: [{ article: "asc" }, { id: "asc" }],
                omit: { raw: true },
            }),
            db.product.count({ where }),
            db.product.groupBy({
                by: ["category", "brand"],
                where: { storeId: id },
                _count: true,
            }),
            db.product.groupBy({
                by: ["protection"],
                where: { storeId: id },
                _count: true,
            }),
            db.product.count({ where: { storeId: id, locked: true } }),
        ]);
        return {
            items,
            buyerPrices: await db.store.findUnique({ where: { id }, select: { buyerPricesCheckedAt: true, buyerPricesStatus: true } }),
            total,
            page,
            pages: Math.ceil(total / limit),
            facets,
            stats,
            lockedCount,
        };
    }
    @UseGuards(AuthGuard)
    @Post("stores/:id/prices")
    prices(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @Body()
    b: any) {
        return submitChanges(r.userId, id, b.changes, b.preserveLocks === true);
    }
    @UseGuards(AuthGuard)
    @Post("stores/:id/locks")
    locks(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @Body()
    body: unknown) {
        return submitLocks(r.userId, id, body);
    }
    @UseGuards(AuthGuard)
    @Get("stores/:id/excel")
    async excel(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @Res()
    res: Response) {
        const bytes = await exportPrices(r.userId, id);
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", 'attachment; filename="sellerpro-prices.xlsx"');
        res.send(Buffer.from(bytes));
    }
    @UseGuards(AuthGuard)
    @Post("stores/:id/excel/preview")
    @UseInterceptors(FileInterceptor("file", {
        limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }))
    async preview(
    @Req()
    r: AuthedRequest, 
    @Param("id")
    id: string, 
    @UploadedFile()
    file: Express.Multer.File) {
        if (!file)
            throw new BadRequestException("Chọn file XLSX.");
        return previewExcel(r.userId, id, file.buffer);
    }
}
