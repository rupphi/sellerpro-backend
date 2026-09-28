import { automationSchema, automationSettings, defaultSalesPeriod, defaultFinancePeriod } from "./automation.policy";
import { z } from "zod";

type StepResult = { step: string; status: string };
type Dependencies = {
  catalog: (progress: (n: number) => Promise<void>) => Promise<void>;
  pricing: (progress: (n: number) => Promise<void>) => Promise<string>;
  guard: (progress: (n: number) => Promise<void>) => Promise<{ errors: string[] }>;
  sales: (period: ReturnType<typeof defaultSalesPeriod>, progress: (n: number) => Promise<void>) => Promise<{ errors: string[] }>;
  finance?: (period: ReturnType<typeof defaultFinancePeriod>, progress: (n: number) => Promise<void>) => Promise<{ errors: string[] }>;
};
/** Mandatory catalog first; unsupported/failed downstream groups are never called successful. */
export async function runInitialization(input: unknown, platform: string, dependencies: Dependencies, progress: (n: number) => Promise<void>, now = new Date(), checkpoint: (value: { steps: StepResult[]; activeStep: string | null }) => Promise<void> = async () => {}) {
  const payload = z.object({ initialization: z.array(z.enum(["catalog", "pricing", "sales", "finance", "buyer_prices", "guard"])).optional(), initializationGuard: z.boolean().optional() }).parse(input);
  const requested = payload.initialization || ["catalog", "pricing"];
  if (requested[0] !== "catalog" || new Set(requested).size !== requested.length) throw new Error("Thứ tự khởi tạo không hợp lệ.");
  const legacy = requested.some(s => s === "buyer_prices" || s === "guard");
  const settings = automationSchema.parse({ ...automationSettings(null), initialization: legacy ? ["catalog", "pricing"] : requested, initializationGuard: !!payload.initializationGuard || requested.includes("guard") });
  const steps: StepResult[] = [], errors: string[] = [];
  for (const [i, step] of settings.initialization.entries()) {
    await checkpoint({ steps: [...steps], activeStep: step });
    const report = (n: number) => progress(Math.round((i * 100 + n) / settings.initialization.length));
    if (step === "catalog") {
      await dependencies.catalog(report); // Failure stops the chain before price/financial work.
      steps.push({ step, status: "ready" });
    } else if (step === "pricing") {
      const status = await dependencies.pricing(report);
      if (status !== "ready") errors.push("Chưa cập nhật đủ giá cả và chiết khấu.");
      const guarded = settings.initializationGuard ? await dependencies.guard(report) : { errors: [] };
      errors.push(...guarded.errors);
      steps.push({ step, status: status === "ready" && !guarded.errors.length ? "ready" : "needs_review" });
    } else if (step === "finance") {
      if (platform !== "wb" || !dependencies.finance) {
        steps.push({ step, status: "unavailable" }); errors.push("Quyết toán chưa khả dụng cho cửa hàng này."); continue;
      }
      const result = await dependencies.finance(defaultFinancePeriod(now), report);
      errors.push(...result.errors);
      steps.push({ step, status: result.errors.length ? "needs_review" : "ready" });
    } else if (step === "sales") {
      if (platform !== "wb") {
        steps.push({ step, status: "unavailable" });
        errors.push("Phễu bán hàng Ozon chưa khả dụng; đã bỏ qua nhóm này.");
        continue;
      }
      const result = await dependencies.sales(defaultSalesPeriod(now), report);
      errors.push(...result.errors);
      steps.push({ step, status: result.errors.length ? "needs_review" : "ready" });
    }
  }
  await checkpoint({ steps: [...steps], activeStep: null });
  return { steps, errors, message: "Đồng bộ cửa hàng hoàn tất." };
}
