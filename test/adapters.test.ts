import 'dotenv/config';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OzonAdapter, WbAdapter, adapter } from '../src/integrations/marketplaces/adapters';
import { db, redis, queue } from '../src/infrastructure/clients';
after(async()=>{await queue.close();await redis.quit();await db.$disconnect();});
test('Ozon protection preserves a stronger existing minimum and disables automatic pricing',async()=>{
  const api=new OzonAdapter('unit',{clientId:'1',apiKey:'not-a-real-key'});
  let sent:any;
  api.call=async(path,body)=>{assert.equal(path,'/v1/product/import/prices');sent=body;return{result:[{product_id:1,updated:true,errors:[]}]};};
  await api.write({externalId:'1',article:'unit',oldPrice:450000,minPrice:1000000} as any,320000,0,true);
  assert.equal(sent.prices[0].min_price,'10000.00');
  assert.equal(sent.prices[0].price,'3200.00');
  assert.equal(sent.prices[0].auto_action_enabled,'DISABLED');
  assert.equal(sent.prices[0].price_strategy_enabled,'DISABLED');
});
test('WB monitoring at the current price reads state and avoids redundant price uploads',async()=>{
  const api=new WbAdapter('unit','not-a-real-key');const paths:string[]=[];
  api.call=async(host,path)=>{paths.push(path);return{data:{listGoods:[{nmID:1,discount:55,editableSizePrice:false,sizes:[{price:6222}]}]}};};
  await api.write({externalId:'1',article:'unit',raw:{}} as any,622200,55);
  assert.equal(paths.length,1);assert.ok(paths[0].startsWith('/api/v2/list/goods/filter'));
});
test('Normal runtime cannot instantiate a demo marketplace adapter',()=>{
  if(process.env.NODE_ENV!=='test')assert.throws(()=>adapter({demo:true,platform:'wb'} as any));
});
test('Ozon initialization loads metadata before prices and preserves distinct price semantics',async()=>{
  const api=new OzonAdapter('unit',{clientId:'1',apiKey:'fixture'}), paths:string[]=[];
  api.call=async(path,body)=>{
    paths.push(path);
    if(path==='/v3/product/list')return{result:{items:[{product_id:1,offer_id:'one'}],total:1,last_id:''}};
    if(path==='/v1/description-category/tree')return{result:[]};
    if(path==='/v3/product/info/list')return{items:[{id:1,name:'One'}]};
    if(path==='/v4/product/info/attributes')return{result:[]};
    if(path==='/v5/product/info/prices')return{items:[{product_id:1,offer_id:'one',price:{price:3200,old_price:4500,marketing_seller_price:3000,min_price:2900,currency_code:'RUB'}}],total:1};
    throw new Error('Unexpected endpoint');
  };
  const metadata=await api.catalog(async()=>{},true);
  assert.equal(paths[0],'/v3/product/list');
  assert.equal(paths.includes('/v5/product/info/prices'),false);
  assert.equal(metadata[0].price,0);
  const priced=await api.hydratePrices(metadata,async()=>{});
  assert.equal(paths.at(-1),'/v5/product/info/prices');
  assert.deepEqual([priced[0].price,priced[0].oldPrice,priced[0].salePrice,priced[0].discount],[320000,450000,300000,0]);
  api.call=async()=>({items:[],total:2});
  await assert.rejects(()=>api.hydratePrices(metadata,async()=>{}));
});
