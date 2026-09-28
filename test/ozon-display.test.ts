import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInitialization } from '../src/modules/automation/initialization.runner';
test('initialization checkpoints expose phase and completed steps even before finish',async()=>{
  const states:any[]=[];
  const deps={catalog:async()=>{},pricing:async()=> 'ready',guard:async()=>({errors:[]}),sales:async()=>({errors:[]})};
  await runInitialization({initialization:['catalog','pricing']},'ozon',deps,async()=>{},new Date(),async state=>{states.push(state);});
  assert.deepEqual(states.map(s=>s.activeStep),['catalog','pricing',null]);
  assert.deepEqual(states[1].steps,[{step:'catalog',status:'ready'}]);
  assert.equal(states[2].steps.length,2);
});
