import 'dotenv/config';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db, redis, queue } from '../src/infrastructure/clients';
import { encrypt } from '../src/common/security';
import { OzonAdapter } from '../src/integrations/marketplaces/adapters';
import { refreshProtectionPrices, updatePrices } from '../src/modules/pricing/price-jobs';
after(async () => { await queue.close(); await redis.quit(); await db.$disconnect(); });

test('Ozon protection refresh uses only prices, preserves metadata/targets and fails closed', async t => {
    const user = await db.user.create({ data: { username: `refresh_${randomUUID()}`, passwordHash: 'fixture' } });
    try {
        const store = await db.store.create({ data: { userId: user.id, name: 'Fixture', platform: 'ozon',
            fingerprint: randomUUID(), credentials: encrypt({ clientId: 'fixture', apiKey: 'fixture' }) } });
        const product = await db.product.create({ data: { storeId: store.id, externalId: '1', article: 'test',
            title: 'Keep title', brand: 'Keep brand', category: 'Keep category', price: 300000,
            salePrice: 300000, locked: true, targetPrice: 300000, targetDiscount: 0, protection: 'attention',
            raw: { details: { retained: true } } } });
        let rows: any[] = [{ product_id: 1, price: { price: 3200, old_price: 4500, min_price: 3100,
            marketing_seller_price: 3150, currency_code: 'RUB', auto_action_enabled: false,
            auto_add_to_ozon_actions_list_enabled: true }, marketing_actions: { ozon_actions_exist: false } }];
        const calls: string[] = [];
        t.mock.method(OzonAdapter.prototype, 'call', async (path: string) => {
            calls.push(path); assert.equal(path, '/v5/product/info/prices');
            return { items: rows, total: rows.length };
        });
        await refreshProtectionPrices(store, async () => {}, [product.id]);
        const saved = await db.product.findUniqueOrThrow({ where: { id: product.id } });
        assert.deepEqual(calls, ['/v5/product/info/prices']);
        assert.equal(saved.price, 320000); assert.equal(saved.salePrice, 315000);
        assert.equal(saved.targetPrice, 300000); assert.equal(saved.locked, true);
        assert.equal(saved.protection, 'attention'); assert.equal(saved.title, 'Keep title');
        assert.equal(saved.brand, 'Keep brand'); assert.equal(saved.category, 'Keep category');
        assert.deepEqual((saved.raw as any).details, { retained: true });
        rows = [];
        await assert.rejects(() => refreshProtectionPrices(store, async () => {}, [product.id]));
        assert.deepEqual(await db.product.findUnique({ where: { id: product.id } }), saved);
        assert.equal(await db.audit.count({ where: { storeId: store.id } }), 0);
    } finally { await db.user.delete({ where: { id: user.id } }); }
});

test('failed Ozon readback reports unverified writes and attention without resending', async t => {
    const user = await db.user.create({ data: { username: `verify_${randomUUID()}`, passwordHash: 'fixture' } });
    const fingerprint = randomUUID();
    try {
        const store = await db.store.create({ data: { userId: user.id, name: 'Fixture', platform: 'ozon',
            fingerprint, credentials: encrypt({ clientId: 'fixture', apiKey: 'fixture' }) } });
        const product = await db.product.create({ data: { storeId: store.id, externalId: '1', article: 'test',
            title: 'Test', price: 300000, salePrice: 300000 } });
        let writes = 0;
        t.mock.method(OzonAdapter.prototype, 'write', async () => { writes++; });
        t.mock.method(OzonAdapter.prototype, 'hydratePrices', async () => { throw new Error('readback unavailable'); });
        const result = await updatePrices(store, [{ id: product.id, version: product.version, price: 300000,
            discount: 0, locked: true }], randomUUID(), async () => {});
        assert.equal(writes, 1); assert.equal(result.updated, 1);
        assert.match(result.errors.join(' '), /chưa xác nhận/);
        const saved = await db.product.findUniqueOrThrow({ where: { id: product.id } });
        assert.equal(saved.protection, 'attention'); assert.equal(saved.targetPrice, 300000);
        assert.equal(await db.audit.count({ where: { storeId: store.id, action: 'price.verification_unavailable' } }), 1);
    } finally {
        await redis.del(`write:${fingerprint}:1`);
        await db.user.delete({ where: { id: user.id } });
    }
});
