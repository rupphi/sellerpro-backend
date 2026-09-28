import { test } from "node:test";
import assert from "node:assert/strict";
import { money, effective, changesSchema } from "../src/modules/pricing/pricing.domain";
test("Money uses integer kopecks and preserves decimals", () => {
  assert.equal(money("3200.15"), 320015);
  assert.equal(effective(320000, 10), 288000);
  assert.throws(() => money("invalid"));
  assert.throws(() => money(-1));
});
test("Price input rejects duplicate rows, invalid discount and negative price", () => {
  const p = {
    id: "00000000-0000-4000-a000-000000000001",
    version: 1,
    price: 320000,
    discount: 10,
    locked: true,
  };
  assert.ok(changesSchema.safeParse([p]).success);
  assert.equal(changesSchema.safeParse([p, p]).success, false);
  assert.equal(
    changesSchema.safeParse([{ ...p, discount: 101 }]).success,
    false,
  );
  assert.equal(changesSchema.safeParse([{ ...p, price: -100 }]).success, false);
});
