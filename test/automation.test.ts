import { test } from "node:test";
import assert from "node:assert/strict";
import { automationSchema, automationSettings, DEFAULT_AUTOMATION, latestSlot } from "../src/modules/automation/automation.policy";
import { scheduleAutomation } from "../src/modules/automation/automation.scheduler";

test("group scheduler queues supported groups with real sales dates and skips Ozon sales", async () => {
  const config = structuredClone(DEFAULT_AUTOMATION);
  config.timezone = "UTC";
  for (const kind of ["catalog", "buyer_prices", "sales", "guard"] as const) config[kind] = { enabled: true, times: ["08:00"] };
  const version = new Date("2026-09-28T07:00:00Z"), created: any[] = [];
  const stores = ["wb", "ozon"].map(platform => ({ id: platform, platform, userId: "owner", createdAt: version, user: { automation: config, automationUpdatedAt: version } }));
  const tx = { $queryRaw: async () => [], store: { count: async () => 1 }, user: { findUniqueOrThrow: async () => stores[0].user }, product: { count: async () => 1 }, task: { count: async () => 0, upsert: async (arg: any) => { created.push(arg.create); } } };
  const db: any = { store: { findMany: async () => stores }, $transaction: async (fn: any) => fn(tx) };
  await scheduleAutomation(db, true, new Date("2026-09-28T08:05:00Z"));
  assert.deepEqual(created.filter(t => t.storeId === "wb").map(t => t.kind), ["catalog", "buyer_prices", "sales", "guard"]);
  assert.deepEqual(created.filter(t => t.storeId === "ozon").map(t => t.kind), ["catalog", "buyer_prices", "guard"]);
  assert.equal(created.find(t => t.kind === "sales").payload.from, "2026-09-21");
  assert.equal(created.find(t => t.kind === "sales").payload.compareTo, "2026-09-20");
});

test("automation defaults, validation and dependency order", () => {
  assert.equal(automationSettings({}).buyer_prices.times.length, 2);
  assert.equal(automationSettings({}).guard.times.length, 4);
  for (const invalid of [
    { timezone: "Invalid/Zone" },
    { initialization: ["buyer_prices", "catalog"] },
    { initialization: ["catalog", "guard", "guard"] },
    { guard: { enabled: true, times: ["08:00", "08:00"] } },
    { guard: { enabled: true, times: ["23:50", "00:10"] } },
    { guard: { enabled: true, times: ["24:00"] } },
    { guard: { enabled: false, times: [] } },
  ]) assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, ...invalid }).success, false);
  assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, initialization: ["catalog", "pricing", "sales"] }).success, true);
  assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, initialization: ["catalog", "sales", "pricing"] }).success, false);
  assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, initialization: ["catalog", "sales"] }).success, false);
  assert.equal(automationSchema.safeParse({ ...DEFAULT_AUTOMATION, finance: { enabled: true, times: ["10:00"] } }).success, true);
  const legacy = automationSettings({ timezone: "Europe/Moscow", buyer_prices: { enabled: false, times: ["11:00"] }, guard: { enabled: false, times: ["12:00"] }, initialization: ["catalog", "guard", "buyer_prices"] });
  assert.deepEqual(legacy.initialization, ["catalog", "pricing"]);
  assert.equal(legacy.initializationGuard, true);
  assert.deepEqual(legacy.buyer_prices, { enabled: false, times: ["11:00"] });
  assert.equal(legacy.sales.enabled, false);
});
test("daily slots use local time, boundaries and coalesce downtime to latest slot", () => {
  const times = ["08:00", "20:00"];
  assert.equal(latestSlot("Asia/Ho_Chi_Minh", times, new Date("2026-09-28T00:59:59Z"))?.key, "2026-09-27T20:00");
  assert.equal(latestSlot("Asia/Ho_Chi_Minh", times, new Date("2026-09-28T01:00:00Z"))?.at.toISOString(), "2026-09-28T01:00:00.000Z");
  assert.equal(latestSlot("Europe/Moscow", times, new Date("2026-09-28T19:00:00Z"))?.key, "2026-09-28T20:00");
});
test("DST skipped slots are skipped and repeated hours keep the same deduplication key", () => {
  const a = latestSlot("America/New_York", ["01:30"], new Date("2026-11-01T05:35:00Z"));
  const b = latestSlot("America/New_York", ["01:30"], new Date("2026-11-01T06:35:00Z"));
  assert.equal(a?.key, b?.key);
  assert.equal(latestSlot("America/New_York", ["02:30"], new Date("2026-03-08T08:00:00Z"))?.key, "2026-03-07T02:30");
});
