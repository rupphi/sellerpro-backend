import ExcelJS from "exceljs";
import { BadRequestException } from "@nestjs/common";
import { db } from "../../infrastructure/clients";
import { ownedStore } from "../stores/stores.service";
import { validateChanges } from "./pricing.service";
import { money } from "./pricing.domain";
export async function exportPrices(userId: string, storeId: string) {
    await ownedStore(userId, storeId);
    const products = await db.product.findMany({
        where: { storeId },
        orderBy: { article: "asc" },
    });
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet("Prices");
    sheet.columns = [
        ["Product ID", "id", 38],
        ["Version", "version", 10],
        ["Brand", "brand", 18],
        ["Category", "category", 22],
        ["Marketplace article", "externalId", 24],
        ["Seller article", "article", 28],
        ["Current price RUB", "price", 20],
        ["New price RUB", "newPrice", 20],
        ["Current discount", "discount", 20],
        ["New discount", "newDiscount", 18],
        ["Locked (YES/NO)", "locked", 22],
    ].map(([header, key, width]) => ({
        header: String(header),
        key: String(key),
        width: Number(width),
    }));
    for (const p of products)
        sheet.addRow({
            ...p,
            price: p.price / 100,
            newPrice: "",
            newDiscount: "",
            locked: p.locked ? "YES" : "NO",
        });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = "A1:K1";
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF7C3AED" },
    };
    for (let i = 2; i <= sheet.rowCount; i++)
        for (const col of [8, 10, 11])
            sheet.getCell(i, col).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: "FFF3EDFF" },
            };
    const info = book.addWorksheet("Instructions");
    info.addRows([
        ["Chỉ sửa New price RUB, New discount, Locked (YES/NO)."],
        ["Để trống ô giá/giảm giá để giữ nguyên. Giá dùng RUB."],
        ["Không sửa ID hoặc Version. File cũ sẽ bị từ chối nếu giá đã đổi."],
        [
            "Khóa WB là giám sát và khôi phục giá; cần khóa auto-action trong Seller.",
        ],
        [
            "Khóa Ozon không ngăn ưu đãi do Ozon tài trợ; xem cảnh báo khuyến mại trong ứng dụng.",
        ],
    ]);
    info.getColumn(1).width = 110;
    return book.xlsx.writeBuffer();
}
export async function previewExcel(userId: string, storeId: string, buffer: Buffer) {
    await ownedStore(userId, storeId);
    const book = new ExcelJS.Workbook();
    try {
        await book.xlsx.load(buffer as any);
    }
    catch {
        throw new BadRequestException("File XLSX không hợp lệ.");
    }
    const sheet = book.getWorksheet("Prices");
    if (!sheet || sheet.rowCount > 10001)
        throw new BadRequestException("Dùng sheet Prices từ mẫu; tối đa 10.000 dòng/file.");
    const changes: any[] = [], errors: {
        row: number;
        message: string;
    }[] = [];
    const products = await db.product.findMany({ where: { storeId } });
    const byId = new Map(products.map((x) => [x.id, x]));
    const cell = (row: ExcelJS.Row, col: number) => {
        const value = row.getCell(col).value;
        if (value !== null && typeof value === "object")
            throw new Error("Không dùng công thức hoặc rich text trong ô sửa.");
        return value;
    };
    for (let i = 2; i <= sheet.rowCount; i++) {
        try {
            const row = sheet.getRow(i);
            if (!row.hasValues)
                continue;
            const id = String(cell(row, 1)), p = byId.get(id);
            if (!p)
                throw new Error("ID không thuộc cửa hàng.");
            const value = cell(row, 8), dis = cell(row, 10), lock = String(cell(row, 11) || "").toUpperCase();
            if (!["YES", "NO"].includes(lock))
                throw new Error("Locked phải là YES hoặc NO.");
            const change = {
                id,
                version: Number(cell(row, 2)),
                price: value === null || value === "" ? p.price : money(value),
                discount: dis === null || dis === "" ? p.discount : Number(dis),
                locked: lock === "YES",
            };
            if (change.price !== p.price ||
                change.discount !== p.discount ||
                change.locked !== p.locked)
                changes.push(change);
        }
        catch (e) {
            errors.push({ row: i, message: (e as Error).message });
        }
    }
    if (changes.length > 1000)
        errors.push({
            row: 0,
            message: "Tối đa 1.000 thay đổi/lần. Chia nhỏ file.",
        });
    if (!errors.length && changes.length) {
        try {
            await validateChanges(userId, storeId, changes);
        }
        catch (e) {
            errors.push({ row: 0, message: (e as Error).message });
        }
    }
    return {
        changes: errors.length ? [] : changes,
        errors,
        total: changes.length,
    };
}
