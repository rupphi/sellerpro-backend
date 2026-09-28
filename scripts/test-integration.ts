import { spawn, ChildProcess } from 'node:child_process';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const env={...process.env,NODE_ENV:'test',PORT:'4001',TEST_FIXTURES:'1',TEST_API_URL:'http://127.0.0.1:4001/api'};
  const children:ChildProcess[]=[];
  const launch=(args:string[])=>{const child=spawn(process.execPath,[require.resolve('tsx/cli'),...args],{cwd:process.cwd(),env,stdio:'inherit'});children.push(child);return child;};
  try {
    launch(['src/main.ts']);launch(['src/worker.ts']);
    let ready=false;
    for(let i=0;i<40;i++){try{ready=(await fetch(env.TEST_API_URL+'/health')).ok;}catch{}if(ready)break;await delay(250);}
    if(!ready)throw new Error('Integration API failed to start');
    const test=launch(['--test','test/integration.test.ts']);
    const code=await new Promise<number|null>(r=>test.once('exit',r));
    process.exitCode=code ?? 1;
  }finally{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');}
}
void main().catch(e=>{console.error(e.message);process.exitCode=1;});
