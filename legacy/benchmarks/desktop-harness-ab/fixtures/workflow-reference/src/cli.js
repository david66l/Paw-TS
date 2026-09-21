import{loadQueue,saveQueue}from'./store.js';
const num=s=>{if(typeof s!=='string'||!/^\d+$/.test(s)||!Number.isSafeInteger(Number(s)))throw Error('integer');return Number(s);};
try{const[file,cmd,...a]=process.argv.slice(2);if(!file)throw Error('file');const counts={add:[2,3],claim:[3],complete:[4],fail:[4],cancel:[1],expire:[1],list:[0,1]};if(!counts[cmd]?.includes(a.length))throw Error('arguments');const q=await loadQueue(file);let r;
if(cmd==='add')r=q.add(a[0],JSON.parse(a[1]),a[2]===undefined?{}:JSON.parse(a[2]));if(cmd==='claim')r=q.claim(a[0],{now:num(a[1]),leaseMs:num(a[2])});if(cmd==='complete'||cmd==='fail')r=q[cmd](a[0],a[1],JSON.parse(a[2]),num(a[3]));if(cmd==='cancel')r=q.cancel(a[0]);if(cmd==='expire')r=q.expire(num(a[0]));if(cmd==='list')r=q.list(a[0]===undefined?{}:{status:a[0]});else await saveQueue(file,q);console.log(JSON.stringify(r));
}catch(e){console.error(e.message);process.exitCode=1;}
