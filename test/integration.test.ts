import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";
import { scheduleAutomation } from "../src/modules/automation/automation.scheduler";
import { DEFAULT_AUTOMATION } from "../src/modules/automation/automation.policy";
const base = process.env.TEST_API_URL || "http://127.0.0.1:4000/api";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test(
  "Account isolation, queued sync, price verification, stale edits, Excel and logout",
  { timeout: 90000, skip: process.env.TEST_FIXTURES !== "1" },
  async () => {
    const db = new PrismaClient();
    const ids: string[] = [];
    const register = async () => {
      const username = `test_${randomBytes(6).toString("hex")}`;
      const r = await fetch(`${base}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "Test6!" }),
      });
      assert.equal(r.status, 201);
      const user = await r.json();
      ids.push(user.id);
      assert.match(r.headers.get("set-cookie")!, /Max-Age=34560000/);
      assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
      return r.headers.get("set-cookie")!.split(";")[0];
    };
    const call = async (
      path: string,
      cookie: string,
      body?: any,
      method = body ? "POST" : "GET",
    ) => {
      const r = await fetch(base + path, {
        method,
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json() };
    };
    const waitTask = async (storeId: string, cookie: string, id?: string) => {
      for (let i = 0; i < 100; i++) {
        const { data } = await call(`/stores/${storeId}/tasks`, cookie);
        const t = id
          ? data.find((x: any) => x.id === id)
          : data.find((x: any) => x.kind === "sync");
        if (t && ["completed", "failed", "needs_review"].includes(t.status)) {
          assert.equal(t.status, "completed", JSON.stringify(t));
          return t;
        }
        await sleep(350);
      }
      throw new Error("Task did not complete");
    };
    try {
      assert.equal((await fetch(base + "/stores")).status, 401);
      assert.equal((await fetch(base + "/automation")).status, 401);
      const shortPassword = await fetch(base + "/auth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "short_password_fixture", password: "12345" }),
      });
      assert.equal(shortPassword.status, 400);
      const alice = await register(),
        bob = await register();
      const admin = await register();
      assert.equal((await call("/auth/me", admin)).data.role, "USER");
      await db.user.update({ where: { id: ids[2] }, data: { role: "ADMIN" } });
      const adminSettingsPath = `/admin/accounts/${ids[0]}/automation`;
      assert.equal((await fetch(base + "/admin/accounts")).status, 401);
      assert.equal((await call("/admin/accounts", alice)).status, 403);
      assert.equal((await call(adminSettingsPath, alice)).status, 403);
      assert.equal((await call("/admin/accounts", admin)).status, 200);
      const injected = await fetch(base + "/auth/register", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "role_injection_test", password: "Test6!", role: "ADMIN" }) });
      assert.equal(injected.status, 400);
      const session = await db.session.findFirstOrThrow({ where: { userId: ids[0] } });
      assert.equal(session.expiresAt, null);
      // Returning to the same browser reuses its token and renews the cookie.
      await db.session.update({ where: { id: session.id }, data: {
        renewedAt: new Date(Date.now() - 2 * 86400000),
      } });
      const renewed = await fetch(base + "/auth/me", { headers: { Cookie: alice } });
      assert.equal(renewed.status, 200);
      assert.match(renewed.headers.get("set-cookie")!, /Max-Age=34560000/);
      assert.equal(renewed.headers.get("set-cookie")!.split(";")[0], alice);
      // Existing valid seven-day sessions upgrade without another login.
      await db.session.update({ where: { id: session.id }, data: {
        expiresAt: new Date(Date.now() + 86400000),
      } });
      assert.equal((await call("/auth/me", alice)).status, 200);
      assert.equal((await db.session.findUniqueOrThrow({ where: { id: session.id } })).expiresAt, null);
      const originalSettings = (await call("/automation", alice)).data;
      assert.equal((await call("/automation", alice, originalSettings, "PATCH")).status, 403);
      assert.equal((await call(adminSettingsPath, bob, originalSettings, "PATCH")).status, 403);
      assert.deepEqual(originalSettings.settings, DEFAULT_AUTOMATION);
      const invalidSettings = structuredClone(originalSettings);
      invalidSettings.settings.initialization = ["buyer_prices", "catalog"];
      assert.equal((await call(adminSettingsPath, admin, invalidSettings, "PATCH")).status, 400);
      const configured = await call(adminSettingsPath, admin, {
        ...originalSettings, settings: { ...DEFAULT_AUTOMATION, initialization: ["catalog", "pricing"], initializationGuard: true },
      }, "PATCH");
      assert.equal(configured.status, 200);
      assert.deepEqual((await call("/automation", bob)).data, originalSettings, "settings must be account scoped");
      assert.equal((await call(adminSettingsPath, admin, originalSettings, "PATCH")).status, 409);
      const store = await call("/stores", alice, {
        name: "Integration store",
        platform: "wb",
        demo: true,
      });
      assert.equal(store.status, 201);
      assert.equal(store.data.credentials, undefined);
      const id = store.data.id;
      const initialized = await waitTask(id, alice);
      assert.deepEqual(initialized.result.steps.map((s: any) => s.step), ["catalog", "pricing"]);
      const products = await call(`/stores/${id}/products`, alice);
      assert.equal(products.data.total, 18);
      assert.equal((await call(`/stores/${id}/products`, bob)).status, 404);
      assert.equal((await call(`/stores/${id}/excel`, bob)).status, 404);
      const p = products.data.items[0];
      assert.equal(products.data.buyerPrices.buyerPricesStatus, "ready");
      assert.equal(p.buyerPrice, null);
      // No lock required: a fresh store waits for its daily slot, then runs once
      // even if multiple worker replicas dispatch concurrently.
      await scheduleAutomation(db, true);
      assert.equal(await db.task.count({ where: { storeId: id, kind: "buyer_prices" } }), 0);
      const beforeRefresh = await db.product.findMany({ where: { storeId: id }, orderBy: { id: "asc" } });
      const daily = structuredClone(DEFAULT_AUTOMATION);
      daily.timezone = "UTC";
      daily.buyer_prices.times = [new Date().toISOString().slice(11, 16)];
      daily.guard.enabled = false;
      await db.user.update({ where: { id: ids[0] }, data: {
        automation: daily, automationUpdatedAt: new Date(Date.now() - 120000),
      } });
      await db.store.update({ where: { id }, data: {
        createdAt: new Date(Date.now() - 120000),
        buyerPricesCheckedAt: new Date(Date.now() - 31 * 60000),
        buyerPricesStatus: "unavailable",
      } });
      await Promise.all([scheduleAutomation(db, true), scheduleAutomation(db, true)]);
      const refresh = await db.task.findMany({ where: { storeId: id, kind: "buyer_prices" } });
      assert.equal(refresh.length, 1);
      await waitTask(id, alice, refresh[0].id);
      const refreshedStore = await db.store.findUniqueOrThrow({ where: { id } });
      assert.equal(refreshedStore.buyerPricesStatus, "ready");
      assert.ok(refreshedStore.buyerPricesCheckedAt!.getTime() > Date.now() - 60000);
      const afterRefresh = await db.product.findMany({ where: { storeId: id }, orderBy: { id: "asc" } });
      assert.deepEqual(
        afterRefresh.map(({ updatedAt, ...product }) => product),
        beforeRefresh.map(({ updatedAt, ...product }) => product),
        "discount refresh must not change prices, versions or lock targets",
      );
      await scheduleAutomation(db, true);
      assert.equal(await db.task.count({ where: { storeId: id, kind: "buyer_prices" } }), 1);
      // Saving a new schedule cancels queued automatic work, not manual work.
      const settingsBeforePause = (await call("/automation", alice)).data;
      const queuedAutomatic = await db.task.create({ data: { storeId: id, kind: "buyer_prices", scheduleKey: `${id}:future-test` } });
      const paused = structuredClone(settingsBeforePause);
      paused.settings.buyer_prices.enabled = false;
      assert.equal((await call(adminSettingsPath, admin, paused, "PATCH")).status, 200);
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: queuedAutomatic.id } })).status, "cancelled");
      const historicalPrice = {
        customerPrice: 123400,
        discountPercent: 25,
        discountKind: "reported",
        currency: "RUB",
        transactionAt: new Date().toISOString(),
        collectedAt: new Date().toISOString(),
        source: "wb_sale",
      };
      await db.product.update({
        where: { id: p.id },
        data: { buyerPrice: historicalPrice },
      });
      const change = {
        id: p.id,
        version: p.version,
        price: p.price + 10000,
        discount: 5,
        locked: true,
      };
      const queued = await call(`/stores/${id}/prices`, alice, {
        changes: [change],
      });
      assert.equal(queued.status, 201);
      await waitTask(id, alice, queued.data.id);
      const updated = (
        await call(`/stores/${id}/products`, alice)
      ).data.items.find((x: any) => x.id === p.id);
      assert.equal(updated.price, change.price);
      assert.equal(updated.locked, true);
      assert.equal(updated.protection, "demo");
      assert.deepEqual(updated.buyerPrice, historicalPrice);
      assert.equal(updated.raw, undefined);
      assert.equal(
        (await call(`/stores/${id}/prices`, alice, { changes: [change] }))
          .status,
        409,
      );
      assert.equal(
        (
          await call(`/stores/${id}/prices`, bob, {
            changes: [{ ...change, version: updated.version }],
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await call(`/stores/${id}/prices`, alice, {
            changes: [{ ...change, version: updated.version, price: -1 }],
          })
        ).status,
        400,
      );
      const exp = await fetch(`${base}/stores/${id}/excel`, {
        headers: { Cookie: alice },
      });
      assert.equal(exp.status, 200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await exp.arrayBuffer()) as any);
      const sheet = wb.getWorksheet("Prices")!;
      assert.equal(sheet.rowCount, 19);
      sheet.getCell("H2").value = 5000;
      const form = new FormData();
      form.append(
        "file",
        new Blob([(await wb.xlsx.writeBuffer()) as any]),
        "test.xlsx",
      );
      const upload = await fetch(`${base}/stores/${id}/excel/preview`, {
        method: "POST",
        headers: { Cookie: alice },
        body: form,
      });
      const preview = await upload.json();
      assert.equal(upload.status, 201);
      assert.deepEqual(preview.errors, []);
      assert.equal(preview.changes.length, 1);
      assert.equal(preview.changes[0].price, 500000);
      sheet.getCell("H2").value = { formula: "1+1" };
      const badForm = new FormData();
      badForm.append(
        "file",
        new Blob([(await wb.xlsx.writeBuffer()) as any]),
        "bad.xlsx",
      );
      const invalid = await (
        await fetch(`${base}/stores/${id}/excel/preview`, {
          method: "POST",
          headers: { Cookie: alice },
          body: badForm,
        })
      ).json();
      assert.equal(invalid.changes.length, 0);
      assert.ok(invalid.errors.length);
      const audit = await call(`/stores/${id}/audit`, alice);
      assert.ok(audit.data.some((x: any) => x.action === "price.verified"));
      assert.ok((await call("/notifications", alice)).data.length > 0);
      const cross = await fetch(base + "/stores", {
        method: "POST",
        headers: {
          Cookie: alice,
          Origin: "https://evil.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "CSRF", platform: "wb", demo: true }),
      });
      assert.equal(cross.status, 403);
      // Worker regression: more waiting jobs than concurrency must still finish.
      const burst = await Promise.all(
        Array.from({ length: 6 }, () =>
          db.task.create({ data: { storeId: id, kind: "sync" } }),
        ),
      );
      for (const task of burst) await waitTask(id, alice, task.id);
      // A local demo price drift is restored without replacing its target.
      await db.product.update({
        where: { id: p.id },
        data: { price: 100000, salePrice: 95000 },
      });
      const guard = await db.task.create({
        data: { storeId: id, kind: "guard" },
      });
      await waitTask(id, alice, guard.id);
      const restored = await db.product.findUniqueOrThrow({
        where: { id: p.id },
      });
      assert.equal(restored.price, change.price);
      assert.equal(restored.targetPrice, change.price);
      // Price protection uses daily slots too, only when a product is locked.
      const guardDaily = structuredClone(DEFAULT_AUTOMATION);
      guardDaily.timezone = "UTC";
      guardDaily.guard.times = [new Date().toISOString().slice(11, 16)];
      guardDaily.buyer_prices.enabled = false;
      await db.user.update({ where: { id: ids[0] }, data: {
        automation: guardDaily, automationUpdatedAt: new Date(Date.now() - 120000),
      } });
      await Promise.all([scheduleAutomation(db, true), scheduleAutomation(db, true)]);
      const dailyGuards = await db.task.findMany({ where: { storeId: id, kind: "guard", scheduleKey: { not: null } } });
      assert.equal(dailyGuards.length, 1);
      await waitTask(id, alice, dailyGuards[0].id);
      const beforeOzon = (await call("/automation", alice)).data;
      beforeOzon.settings.guard.enabled = false;
      beforeOzon.settings.initialization = ["catalog"];
      beforeOzon.settings.initializationGuard = false;
      assert.equal((await call(adminSettingsPath, admin, beforeOzon, "PATCH")).status, 200);
      // Ozon demo must expose direct selling prices (no seller discount).
      const ozon = await call("/stores", alice, {
        name: "Ozon integration",
        platform: "ozon",
        demo: true,
      });
      const ozonInitialized = await waitTask(ozon.data.id, alice);
      assert.deepEqual(ozonInitialized.result.steps.map((s: any) => s.step), ["catalog", "pricing"]);
      const ozonProducts = await call(
        `/stores/${ozon.data.id}/products`,
        alice,
      );
      assert.ok(ozonProducts.data.items.every((x: any) => x.discount === 0));
      assert.equal(ozonProducts.data.buyerPrices.buyerPricesStatus, "ready");
      const op = ozonProducts.data.items[0];
      const ozonPrice = await call(`/stores/${ozon.data.id}/prices`, alice, {
        changes: [
          {
            id: op.id,
            version: op.version,
            price: 456700,
            discount: 0,
            locked: true,
          },
        ],
      });
      await waitTask(ozon.data.id, alice, ozonPrice.data.id);
      const verified = await db.product.findUniqueOrThrow({
        where: { id: op.id },
      });
      assert.equal(verified.minPrice, 456700);
      assert.equal(verified.protection, "demo");
      // Quick locks are independent of price edits and scoped to the owner/store.
      assert.equal(
        (await call(`/stores/${id}/locks`, bob, { scope: "all", locked: true }))
          .status,
        404,
      );
      assert.equal(
        (
          await call(`/stores/${id}/locks`, alice, {
            scope: "product",
            productId: op.id,
            locked: true,
          })
        ).status,
        400,
      );
      assert.equal(
        (await call(`/stores/${id}/locks`, alice, { locked: true })).status,
        400,
      );
      assert.equal(
        (
          await call(`/stores/${id}/locks`, alice, {
            scope: "all",
            locked: "false",
          })
        ).status,
        400,
      );
      // More than a page: a bulk operation must cover products not visible in the UI.
      await db.product.createMany({
        data: Array.from({ length: 17 }, (_, i) => ({
          storeId: id,
          externalId: `lock-test-${i}`,
          article: `lock-test-${i}`,
          title: "Lock test",
          price: 123400,
          salePrice: 123400,
        })),
      });
      const beforeLocks = await db.product.findMany({
        where: { storeId: id },
        orderBy: { id: "asc" },
      });
      const lockAll = await call(`/stores/${id}/locks`, alice, {
        scope: "all",
        locked: true,
      });
      assert.equal(lockAll.status, 201);
      await waitTask(id, alice, lockAll.data.id);
      const lockedCatalog = await call(
        `/stores/${id}/products?search=lock-test-0`,
        alice,
      );
      assert.equal(lockedCatalog.data.lockedCount, 35);
      assert.equal(lockedCatalog.data.total, 1);
      const afterLocks = await db.product.findMany({
        where: { storeId: id },
        orderBy: { id: "asc" },
      });
      assert.deepEqual(
        afterLocks.map((x) => [x.id, x.price, x.discount]),
        beforeLocks.map((x) => [x.id, x.price, x.discount]),
      );
      assert.ok(afterLocks.every((x) => x.locked));
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: p.id } }))
          .targetPrice,
        change.price,
      );
      // Saving an older lock value from the price editor cannot turn protection off.
      const fresh = afterLocks[0];
      const preserve = await call(`/stores/${id}/prices`, alice, {
        preserveLocks: true,
        changes: [
          {
            id: fresh.id,
            version: fresh.version,
            price: fresh.price,
            discount: fresh.discount,
            locked: false,
          },
        ],
      });
      await waitTask(id, alice, preserve.data.id);
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: fresh.id } }))
          .locked,
        true,
      );
      const quickOff = await call(`/stores/${id}/locks`, alice, {
        scope: "product",
        productId: fresh.id,
        locked: false,
      });
      await waitTask(id, alice, quickOff.data.id);
      const off = await db.product.findUniqueOrThrow({
        where: { id: fresh.id },
      });
      assert.equal(off.locked, false);
      assert.equal(off.targetPrice, null);
      assert.equal(off.price, fresh.price);
      const unlockAll = await call(`/stores/${id}/locks`, alice, {
        scope: "all",
        locked: false,
      });
      await waitTask(id, alice, unlockAll.data.id);
      assert.equal(
        await db.product.count({ where: { storeId: id, locked: true } }),
        0,
      );
      assert.equal(
        (await db.product.findUniqueOrThrow({ where: { id: op.id } })).locked,
        true,
      );
      assert.ok(
        (await call(`/stores/${id}/audit`, alice)).data.some(
          (x: any) => x.action === "lock.disabled",
        ),
      );
      // Sales reporting is read-only, tenant scoped and separates orders from money events.
      const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const periodQuery = `from=${day}&to=${day}`;
      assert.equal((await call(`/stores/${id}/sales?${periodQuery}`, bob)).status, 404);
      assert.equal((await call(`/stores/${id}/finance?${periodQuery}`, bob)).status, 404);
      assert.equal((await call(`/stores/${id}/finance/sync`, bob, { from: day, to: day })).status, 404);
      assert.equal((await call(`/stores/${id}/finance?from=2026-02-30&to=2026-03-01`, alice)).status, 400);
      const finance = await call(`/stores/${id}/finance?${periodQuery}`, alice);
      assert.equal(finance.status, 200);
      assert.deepEqual(finance.data.totals, []);
      assert.equal(finance.data.succeededAt, null);
      assert.equal((await call(`/stores/${ozon.data.id}/finance/sync`, alice, { from: day, to: day })).status, 400);
      assert.equal((await call(`/stores/${id}/sales/events?${periodQuery}`, bob)).status, 404);
      assert.equal((await call(`/stores/${id}/sales?from=2026-02-30&to=2026-03-01`, alice)).status, 400);
      const missingSales = await call(`/stores/${id}/sales?${periodQuery}`, alice);
      assert.equal(missingSales.data.current.ordersReady, false);
      for (const source of ["wb_orders", "wb_sales"]) await db.salesSource.create({ data: {
        storeId: id, source, status: "ready", coveredFrom: new Date(Date.now() - 30 * 86400000), coveredTo: new Date(),
      } });
      const saleSeed = { storeId: id, orderKey: "report-fixture", occurredAt: new Date(day + "T12:00:00+03:00"), channel: "fbs", article: "REPORT-A", title: "Quần kiểm thử", quantity: 1, amount: 120000, currency: "RUB" };
      await db.salesEvent.create({ data: { ...saleSeed, source: "wb_orders", externalKey: "order", kind: "order", status: "ordered" } });
      const saleEvent = await db.salesEvent.create({ data: { ...saleSeed, source: "wb_sales", externalKey: "S1", kind: "sale", status: "delivered" } });
      await db.salesEvent.create({ data: { ...saleSeed, source: "wb_sales", externalKey: "R1", kind: "return", status: "returned" } });
      const sales = await call(`/stores/${id}/sales?${periodQuery}`, alice);
      assert.equal(sales.status, 200);
      assert.equal(sales.data.current.orders, 1);
      assert.equal(sales.data.current.fbs, 1);
      assert.equal(sales.data.current.sales.value, 120000);
      assert.equal(sales.data.current.returns.value, 120000);
      assert.equal(sales.data.current.netRevenue, 0);
      assert.equal(sales.data.current.cohort.returned, 1);
      assert.equal(sales.data.current.ordersReady, true);
      const compareDay = new Date(Date.parse(day) - 7 * 86400000).toISOString().slice(0, 10);
      await db.salesEvent.create({ data: { ...saleSeed, orderKey: "older-comparison", occurredAt: new Date(compareDay + "T12:00:00+03:00"), amount: 80000, source: "wb_orders", externalKey: "older-order", kind: "order", status: "ordered" } });
      const comparison = await call(`/stores/${id}/sales?${periodQuery}&compareFrom=${compareDay}&compareTo=${compareDay}`, alice);
      assert.equal(comparison.status, 200);
      assert.equal(comparison.data.period.previousFrom, compareDay);
      assert.equal(comparison.data.previous.orders, 1);
      assert.equal(comparison.data.previous.orderedValue, 80000);
      assert.equal(comparison.data.current.orderedValue, 120000);
      assert.equal((await call(`/stores/${id}/sales?${periodQuery}`, alice)).data.previous.orders, 0);
      assert.equal((await call(`/stores/${id}/sales?${periodQuery}&compareFrom=${compareDay}`, alice)).status, 400);
      assert.equal((await call(`/stores/${id}/sales?${periodQuery}&compareFrom=${day}&compareTo=${day}`, alice)).status, 400);
      const filtered = await call(`/stores/${id}/sales/events?${periodQuery}&kind=return&search=REPORT-A`, alice);
      assert.equal(filtered.data.items.length, 1);
      assert.equal((await call(`/stores/${id}/sales/orders/${saleEvent.id}`, alice)).data.length, 3);
      assert.equal((await call(`/stores/${id}/sales/orders/${saleEvent.id}`, bob)).status, 404);
      assert.equal((await call(`/stores/${ozon.data.id}/sales/sync`, alice, { from: day, to: day })).status, 400);
      assert.equal((await call(`/stores/${ozon.data.id}/sales?${periodQuery}`, alice)).data.current.salesReady, false);
      // Deletion is owner-scoped, name-confirmed, local only and blocked during work.
      const deletion = { confirmName: "Integration store" };
      assert.equal((await call(`/stores/${id}`, bob, deletion, "DELETE")).status, 404);
      assert.equal((await call(`/stores/${id}`, alice, { confirmName: "wrong" }, "DELETE")).status, 400);
      const running = await db.task.create({ data: { storeId: id, kind: "sync", status: "running" } });
      assert.equal((await call(`/stores/${id}`, alice, deletion, "DELETE")).status, 409);
      await db.task.delete({ where: { id: running.id } });
      assert.equal((await call(`/stores/${id}`, alice, deletion, "DELETE")).status, 200);
      assert.equal(await db.store.count({ where: { id } }), 0);
      assert.equal(await db.product.count({ where: { storeId: id } }), 0);
      assert.equal(await db.task.count({ where: { storeId: id } }), 0);
      assert.equal(await db.salesEvent.count({ where: { storeId: id } }), 0);
      assert.equal((await call(`/stores/${id}/products`, alice)).status, 404);
      assert.equal(await db.store.count({ where: { id: ozon.data.id } }), 1);
      // A role downgrade must immediately remove access even with a persistent session.
      await db.user.update({ where: { id: ids[2] }, data: { role: "USER" } });
      assert.equal((await call("/admin/accounts", admin)).status, 403);
      await call("/auth/logout", alice, {});
      assert.equal((await call("/auth/me", alice)).status, 401);
      assert.equal(await db.session.count({ where: { id: session.id } }), 0);
      // Expired legacy sessions must not be resurrected by the new policy.
      await db.session.updateMany({ where: { userId: ids[1] }, data: {
        expiresAt: new Date(Date.now() - 1000),
      } });
      assert.equal((await call("/auth/me", bob)).status, 401);
    } finally {
      for (const id of ids) await db.user.delete({ where: { id } });
      await db.$disconnect();
    }
  },
);
