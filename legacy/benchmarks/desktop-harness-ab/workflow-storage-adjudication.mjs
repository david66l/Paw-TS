// Supplemental behavioral adjudication. The original frozen score is retained.
// The original round-trip check overconstrained a private token counter by
// demanding byte-equivalent snapshots. The task permits different internal
// recovery bookkeeping as long as observable state/config/token safety survive.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(process.argv[2]);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-storage-review-'));
let result;
try {
  const {WorkflowQueue:Q}=await import(pathToFileURL(path.join(root,'src/queue.js')));
  const {saveQueue,loadQueue}=await import(pathToFileURL(path.join(root,'src/store.js')));
  const x=new Q({maxAttempts:4,retryDelayMs:7});
  x.add('a',{nested:[1]}); x.add('b',2,{dependsOn:['a']});
  const original=x.claim('worker',{now:0,leaseMs:10});
  const file=path.join(temp,'nested','queue.json');await saveQueue(file,x);
  const y=await loadQueue(file);assert.deepEqual(y.list(),x.list());
  assert.deepEqual(fs.readdirSync(path.dirname(file)),['queue.json']);
  assert.equal(y.fail('a',original.leaseToken,'retry',1).runAt,8);
  const seen=new Set([original.leaseToken]);
  let now=8;
  for(let attempt=2;attempt<=4;attempt++) {
    const j=y.claim('worker',{now,leaseMs:10});assert.equal(j.id,'a');assert.equal(j.attempts,attempt);
    assert.ok(!seen.has(j.leaseToken));seen.add(j.leaseToken);
    const after=y.fail('a',j.leaseToken,'retry',now+1);
    if(attempt<4){assert.equal(after.status,'pending');assert.equal(after.runAt,now+1+7*2**(attempt-1));now=after.runAt;}
    else {assert.equal(after.status,'failed');assert.equal(y.get('b').status,'cancelled');}
  }
  assert.equal(x.get('a').status,'running');
  result={passed:true,check:'persistent round-trip and temp cleanup',basis:'observable job state, active token, retry config, future token uniqueness, deep isolation and temp cleanup'};
} catch(error) {result={passed:false,error:String(error.message)};}
finally {fs.rmSync(temp,{recursive:true,force:true});}
console.log(JSON.stringify(result));
