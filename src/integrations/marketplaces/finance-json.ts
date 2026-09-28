/** Node 22+ reviver source preserves WB report IDs beyond 2^53. Fail closed on older runtimes. */
export function parseFinanceJson(text: string): unknown {
  return JSON.parse(text, ((key: string, value: unknown, context?: { source?: string }) => {
    if (key === "reportId" && typeof value === "number") {
      if (context?.source && /^\d+$/.test(context.source)) return context.source;
      if (Number.isSafeInteger(value)) return String(value);
      throw new Error("Không đọc được mã báo cáo chính xác. Cần Node.js hỗ trợ JSON source.");
    }
    return value;
  }) as any);
}
