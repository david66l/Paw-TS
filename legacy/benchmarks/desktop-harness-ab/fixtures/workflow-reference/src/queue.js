const integer=(n,min=0)=>{if(!Number.isSafeInteger(n)||n<min)throw Error('integer');return n;};
const str=x=>{if(typeof x!=='string'||!x.length)throw Error('string');};
function json(x,seen=new Set()) { if(x===null||['string','boolean'].includes(typeof x))return;
 if(typeof x==='number'&&Number.isFinite(x))return;
 if(!x||typeof x!=='object'||seen.has(x)||(!Array.isArray(x)&&Object.getPrototypeOf(x)!==Object.prototype))throw Error('JSON');
 seen.add(x);for(const v of Object.values(x))json(v,seen);seen.delete(x); }
const copy=x=>structuredClone(x);const statuses=['pending','running','completed','failed','cancelled'];
export class WorkflowQueue {
 constructor({maxAttempts=3,retryDelayMs=10}={}){this.config={maxAttempts:integer(maxAttempts,1),retryDelayMs:integer(retryDelayMs)};this.jobs=[];this.counter=0;}
 snapshot(){return copy({version:1,config:this.config,counter:this.counter,jobs:this.jobs});}
 static restore(s){json(s);if(s.version!==1||!Array.isArray(s.jobs))throw Error('snapshot');const q=new WorkflowQueue(s.config);q.counter=integer(s.counter);q.jobs=copy(s.jobs);const ids=new Set(),tokens=new Set();
  for(const j of q.jobs){str(j.id);if(ids.has(j.id))throw Error('duplicate');ids.add(j.id);if(!statuses.includes(j.status)||!Number.isFinite(j.priority)||typeof j.priority!=='number')throw Error('fields');integer(j.runAt);integer(j.attempts);if(j.attempts>q.config.maxAttempts)throw Error('attempts');
   if(!Array.isArray(j.dependsOn)||new Set(j.dependsOn).size!==j.dependsOn.length)throw Error('deps');for(const key of ['payload','result','error'])json(j[key]);
   if(j.status==='running'){str(j.worker);str(j.leaseToken);integer(j.leaseUntil);if(!j.attempts||tokens.has(j.leaseToken)||!/^lease-\d+$/.test(j.leaseToken)||Number(j.leaseToken.slice(6))>q.counter)throw Error('lease');tokens.add(j.leaseToken);}
   else if(j.worker!==null||j.leaseToken!==null||j.leaseUntil!==null)throw Error('inactive lease');
  }
  const visited=new Set(),active=new Set();function visit(id){if(active.has(id)||!ids.has(id))throw Error('graph');if(visited.has(id))return;active.add(id);for(const dep of q.jobs.find(j=>j.id===id).dependsOn)visit(dep);active.delete(id);visited.add(id);}for(const id of ids)visit(id);return q;
 }
 get(id){return copy(this.jobs.find(j=>j.id===id)??null);}
 list({status}={}){if(status!==undefined&&!statuses.includes(status))throw Error('status');return copy(this.jobs.filter(j=>status===undefined||j.status===status));}
 atomic(fn){const before=this.snapshot();try{return copy(fn());}catch(e){this.jobs=before.jobs;this.counter=before.counter;throw e;}}
 clear(j){j.worker=null;j.leaseToken=null;j.leaseUntil=null;}
 cascade(){let changed;do{changed=false;for(const j of this.jobs)if(['pending','running'].includes(j.status)&&j.dependsOn.some(id=>['failed','cancelled'].includes(this.jobs.find(p=>p.id===id)?.status))){j.status='cancelled';this.clear(j);changed=true;}}while(changed);}
 add(id,payload,{dependsOn=[],priority=0,runAt=0}={}){return this.atomic(()=>{str(id);json(payload);if(this.get(id)||!Array.isArray(dependsOn)||new Set(dependsOn).size!==dependsOn.length||dependsOn.some(d=>d===id||!this.get(d)))throw Error('deps/id');if(typeof priority!=='number'||!Number.isFinite(priority))throw Error('priority');integer(runAt);const j={id,payload:copy(payload),dependsOn:copy(dependsOn),priority,runAt,status:'pending',attempts:0,leaseToken:null,leaseUntil:null,worker:null,result:null,error:null};this.jobs.push(j);this.cascade();return j;});}
 retry(j,error,now){j.error=copy(error);this.clear(j);if(j.attempts>=this.config.maxAttempts)j.status='failed';else{j.status='pending';j.runAt=integer(now+this.config.retryDelayMs*2**(j.attempts-1));}this.cascade();}
 expire(now){return this.atomic(()=>{integer(now);const ids=[];for(const j of this.jobs)if(j.status==='running'&&j.leaseUntil<=now){ids.push(j.id);this.retry(j,'lease expired',now);}return ids;});}
 claim(worker,{now,leaseMs}){return this.atomic(()=>{str(worker);integer(now);integer(leaseMs,1);integer(now+leaseMs);this.expire(now);const j=this.jobs.filter(j=>j.status==='pending'&&j.runAt<=now&&j.dependsOn.every(d=>this.jobs.find(x=>x.id===d).status==='completed')).sort((a,b)=>b.priority-a.priority)[0];if(!j)return null;j.status='running';j.attempts++;j.worker=worker;j.leaseUntil=now+leaseMs;j.leaseToken=`lease-${integer(++this.counter,1)}`;return j;});}
 lease(id,token,now){integer(now);const j=this.jobs.find(x=>x.id===id);if(!j||j.status!=='running'||j.leaseToken!==token||now>=j.leaseUntil)throw Error('lease');return j;}
 complete(id,token,result,now){return this.atomic(()=>{const j=this.lease(id,token,now);json(result);j.status='completed';j.result=copy(result);this.clear(j);return j;});}
 fail(id,token,error,now){return this.atomic(()=>{const j=this.lease(id,token,now);json(error);this.retry(j,error,now);return j;});}
 cancel(id){return this.atomic(()=>{const j=this.jobs.find(x=>x.id===id);if(!j||!['pending','running'].includes(j.status))throw Error('cancel');j.status='cancelled';this.clear(j);this.cascade();return j;});}
}
