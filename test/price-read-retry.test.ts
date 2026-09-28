import 'dotenv/config';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MarketplaceHttpError, retryPriceRead } from '../src/integrations/marketplaces/read-retry';
import { OzonAdapter } from '../src/integrations/marketplaces/adapters';
import { db, redis, queue } from '../src/infrastructure/clients';
after(async () => { await queue.close(); await redis.quit(); await db.$disconnect(); });

test('price reads retry transient failures with bounded backoff', async () => {
    let calls = 0; const waits: number[] = [];
    const result = await retryPriceRead(async () => {
        calls++;
        if (calls === 1) throw new DOMException('slow', 'TimeoutError');
        if (calls === 2) throw new MarketplaceHttpError(503, 'unavailable');
        return 42;
    }, async ms => { waits.push(ms); });
    assert.equal(result, 42); assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
});
test('exhausted reads stop after three attempts without exposing raw errors', async () => {
    let calls = 0;
    await assert.rejects(() => retryPriceRead(async () => {
        calls++; throw new TypeError('fetch failed');
    }, async () => {}), /sau 3 lần thử/);
    assert.equal(calls, 3);
});
test('auth, validation and malformed responses are not retried', async () => {
    for (const error of [new MarketplaceHttpError(403, 'denied'), new MarketplaceHttpError(400, 'invalid'), new SyntaxError('invalid JSON')]) {
        let calls = 0;
        await assert.rejects(() => retryPriceRead(async () => { calls++; throw error; }, async () => {}), e => e === error);
        assert.equal(calls, 1);
    }
});
test('Ozon write timeout never enters the price-read retry path', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; throw new DOMException('slow', 'TimeoutError'); });
    const api = new OzonAdapter(`test-${randomUUID()}`, { clientId: 'fixture', apiKey: 'fixture' });
    await assert.rejects(() => api.call('/v1/product/import/prices', { prices: [] }), { name: 'TimeoutError' });
    assert.equal(calls, 1);
});
