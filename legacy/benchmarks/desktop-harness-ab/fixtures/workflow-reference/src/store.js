import fs from 'node:fs/promises';import path from 'node:path';import{randomUUID}from'node:crypto';import{WorkflowQueue}from'./queue.js';
export async function saveQueue(file,q){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(q.snapshot()));await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
export async function loadQueue(file){let text;try{text=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return new WorkflowQueue();throw e;}return WorkflowQueue.restore(JSON.parse(text));}
