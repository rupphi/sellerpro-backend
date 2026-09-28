import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
test('Normal application refuses demo stores and does not expose existing fixtures',{skip:process.env.RUN_LIVE_API_TEST!=='1'},async()=>{
  const base='http://127.0.0.1:4000/api',db=new PrismaClient();let userId:string|undefined;
  try{
    let ready=false;
    for(let i=0;i<40;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250));}
    assert.ok(ready,'Start the normal API on port 4000 before running this integration check');
    const register=await fetch(base+'/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'check_'+randomUUID().slice(0,8),password:randomUUID()})});
    assert.equal(register.status,201);userId=(await register.json()).id;
    const cookie=register.headers.get('set-cookie')!.split(';')[0];
    const result=await fetch(base+'/stores',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'Not a real store',platform:'wb',demo:true})});
    assert.equal(result.status,400);
    assert.deepEqual(await (await fetch(base+'/stores',{headers:{Cookie:cookie}})).json(),[]);
    const hidden=await db.store.create({data:{userId:userId!,name:'Old fixture',platform:'wb',demo:true,credentials:'fixture-not-a-credential',fingerprint:randomUUID()}});
    assert.deepEqual(await (await fetch(base+'/stores',{headers:{Cookie:cookie}})).json(),[]);
    assert.equal((await fetch(base+`/stores/${hidden.id}/products`,{headers:{Cookie:cookie}})).status,404);
  } finally {if(userId)await db.user.delete({where:{id:userId}});await db.$disconnect();}
});
