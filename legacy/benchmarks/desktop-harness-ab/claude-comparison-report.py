"""Grade settled artifacts in Docker and compare observed behavior, not claimed completion."""
import hashlib
import json
import pathlib
import subprocess
import sys
import uuid

paw, claude = (pathlib.Path(arg).resolve() for arg in sys.argv[1:3])
def read(file):
    return json.loads(file.read_text(encoding='utf-8'))
def rows(folder, name):
    file = folder / name
    return [json.loads(line) for line in file.read_text(encoding='utf-8').splitlines()] if file.exists() else []
pp, cp = read(paw/'protocol.json'), read(claude/'protocol.json')
assert pp['goal'] == cp['goal'] and not cp['transportCheckOnly']
assert (paw/'result.json').exists() and (claude/'result.json').exists(), 'Grade only settled runs'
verifier = paw/'source-snapshot/legacy/benchmarks/desktop-harness-ab/verify.mjs'
assert hashlib.sha256(verifier.read_bytes()).hexdigest() == pp['sourceHashes']['legacy/benchmarks/desktop-harness-ab/verify.mjs']

def grade(protocol):
    workspace = pathlib.Path(protocol['workspaceRoot'])
    image = pp['isolation']['imageId']
    def run(command, independent=False):
        name = 'paw-compare-grade-' + uuid.uuid4().hex[:12]
        args = ['docker','run','--rm','--name',name,'--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1024m','--cpus','2','--pids-limit','128','--tmpfs','/tmp:exec,nosuid,size=256m','-w','/workspace','--mount',f'type=bind,source={workspace},target=/workspace' + (',readonly' if independent else '')]
        # Preserve the writer's UID: with all capabilities dropped, root cannot
        # traverse a mode-0700 directory created by Claude's non-root user.
        if protocol.get('claudeVersion'): args += ['--user','1000:1000']
        if independent: args += ['--mount',f'type=bind,source={verifier},target=/verifier.mjs,readonly']
        try:
            process = subprocess.run(args+[image,*command],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            return {'exitCode':process.returncode,'stdout':process.stdout,'stderr':process.stderr}
        except subprocess.TimeoutExpired:
            return {'exitCode':None,'status':'timeout'}
        finally:
            subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    package = workspace/'package.json'
    own = run(['npm','test']) if package.exists() and read(package).get('scripts',{}).get('test') else {'exitCode':None,'status':'missing'}
    verification = run(['node','/verifier.mjs','queue','/workspace'],True)
    assert verification['exitCode'] == 0, verification
    return {'functional':json.loads(verification['stdout']), 'ownTests':own}

def paw_metrics():
    events, parsed = rows(paw,'events.jsonl'), rows(paw,'parsed.jsonl')
    starts = {x['id']:x['at'] for x in parsed if x['type']=='start'}
    finishes = [x for x in parsed if x['type']=='finish']
    usage = [x['usage'] for x in finishes if x.get('usage')]
    first = lambda predicate: next(((x['at']-pp['startedAt'])/1000 for x in events if predicate(x['event'])), None)
    totals = {key:sum(x.get(key,0) for x in usage) for key in ['promptTokens','completionTokens','cachedPromptTokens','cacheMissPromptTokens','totalTokens']}
    return {'result':read(paw/'result.json'),'timing':read(paw/'verification.json'),'usage':totals,'requestsWithoutUsage':len(starts)-len(usage),'firstToolSeconds':first(lambda e:e['type']=='tool.call'),'firstSuccessfulWriteSeconds':first(lambda e:e['type']=='tool.result' and e.get('ok') and e.get('tool') in ['workspace_write_file','workspace_edit_file','workspace_apply_patch']),'requests':[{'id':x['id'],'seconds':(x['at']-starts[x['id']])/1000,'usage':x.get('usage')} for x in finishes]}

def claude_metrics():
    events = rows(claude,'events.jsonl')
    final = next((x['event'] for x in reversed(events) if x['event']['type']=='result'),None)
    tools = []
    results = {}
    for row in events:
        event = row['event']
        if event['type']=='assistant':
            for block in event.get('message',{}).get('content',[]):
                if block['type']=='tool_use': tools.append({'at':row['at'],'id':block['id'],'name':block['name'],'input':block.get('input')})
        if event['type']=='user':
            content=event.get('message',{}).get('content',[])
            for block in content if isinstance(content,list) else []:
                if block.get('type')=='tool_result': results[block['tool_use_id']]={'at':row['at'],'error':block.get('is_error',False)}
    first_write = next(((results[x['id']]['at']-cp['startedAt'])/1000 for x in tools if x['name'] in ['Write','Edit'] and x['id'] in results and not results[x['id']]['error']),None)
    wire=rows(claude,'wire.jsonl'); requests=[]
    for request in [x for x in wire if x['type']=='request' and x['route']=='/v1/messages']:
        id=request['id']; raw=(claude/'relay'/f'{id}.body').read_text(encoding='utf-8')
        sse=[]
        for line in raw.splitlines():
            if line.startswith('data: '):
                try:sse.append(json.loads(line[6:]))
                except json.JSONDecodeError:pass
        start=next((x['message'] for x in sse if x.get('type')=='message_start'),{})
        delta=next((x for x in sse if x.get('type')=='message_delta'),{})
        end=next((x['at'] for x in wire if x['id']==id and x['type']=='end'),None)
        requests.append({'id':id,'seconds':(end-request['at'])/1000 if end else None,'request':{k:request.get(k) for k in ['model','max_tokens','thinking','output_config']},'startUsage':start.get('usage'),'endUsage':delta.get('usage'),'responseModel':start.get('model'),'stopReason':delta.get('delta',{}).get('stop_reason')})
    return {'result':read(claude/'result.json'),'finalEvent':final,'firstToolSeconds':(tools[0]['at']-cp['startedAt'])/1000 if tools else None,'firstSuccessfulWriteSeconds':first_write,'tools':tools,'requests':requests}

report={'paw':{**paw_metrics(),**grade(pp)},'claude':{**claude_metrics(),**grade(cp)},'limitations':['One sequential sample per runtime; not success-rate or latency ranking','Same exact task and native output cap, but different prompts, tools and API protocols','Paw desktop V3 loop; Claude Code native CLI 2.1.224 with six coding tools','Both no delegated coding workers; Paw retains completion review','Paw maxSteps and Claude max-turns are not identical budget semantics','Claude file relay adds polling and filesystem overhead; only model endpoint forwarding is available','Independent verifier checks 15 specified behaviors, not exhaustive correctness','Provider-reported usage; Claude USD estimate is not a GLM bill']}
(claude/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
for name in ['paw','claude']:
    r=report[name]; print(json.dumps({'runtime':name,'functional':f"{r['functional']['passed']}/{r['functional']['total']}",'ownTestsExit':r['ownTests']['exitCode'],'firstToolSeconds':r['firstToolSeconds'],'firstSuccessfulWriteSeconds':r['firstSuccessfulWriteSeconds']},ensure_ascii=True))
