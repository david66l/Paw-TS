// Corrects two frozen checks that assumed returned job copies were writable.
// Read-only copies are permitted by the task; internal/input state must still
// be detached. Preserve every other assertion in the original check groups.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const checks=[];
let Q;
try {Q=(await import(pathToFileURL(path.join(path.resolve(process.argv[2]),'src/queue.js')))).WorkflowQueue;} catch {}
const check=(name,body)=>{try{body();checks.push({name,pass:true});}catch(error){checks.push({name,pass:false,error:String(error.message)});}};
const mutateCopy=(object,key,value)=>{
  try{object[key]=value;}catch(error){assert.ok(error instanceof TypeError);assert.equal(Object.isFrozen(object),true);}
};
const unchanged=(x,fn)=>{const before=JSON.stringify(x.snapshot());assert.throws(fn);assert.equal(JSON.stringify(x.snapshot()),before);};
check('input and returned nested state isolation',()=>{
  const x=new Q(),input={deep:[{n:1}]};
  const added=x.add('a',input);
  input.deep[0].n=8; // The original user input must remain independently writable.
  for(const returned of [added,x.get('a'),x.list()[0]]) {
    assert.notEqual(returned.payload,input);
    mutateCopy(returned.payload.deep[0],'n',9);
    assert.equal(x.get('a').payload.deep[0].n,1);
  }
});
check('complete checks token, status and exact deadline',()=>{
  const x=new Q();x.add('a',1);const a=x.claim('worker',{now:0,leaseMs:10});
  for(const fn of [()=>x.complete('missing',a.leaseToken,1,1),()=>x.complete('a','wrong',1,1),()=>x.complete('a',a.leaseToken,1,10)])unchanged(x,fn);
  const result={value:[1]},done=x.complete('a',a.leaseToken,result,9);
  result.value[0]=9;mutateCopy(done.result.value,0,8);
  assert.deepEqual(x.get('a').result,{value:[1]});
  for(const key of ['leaseToken','leaseUntil','worker'])assert.equal(x.get('a')[key],null);
  unchanged(x,()=>x.complete('a',a.leaseToken,1,9));
});
console.log(JSON.stringify({checks}));
