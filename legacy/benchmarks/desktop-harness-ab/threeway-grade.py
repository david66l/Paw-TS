"""Grade frozen workflow deliveries and normalize provider-reported usage.

Usage: python threeway-grade.py <settled-run> [<settled-run> ...]
Original deliveries are mounted read-only. Self-tests execute on disposable copies.
"""
import collections
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

HERE = pathlib.Path(__file__).resolve().parent
FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

def read(p): return json.loads(p.read_text(encoding='utf-8'))
def rows(root, name):
    p = root/name
    return [json.loads(line) for line in p.read_text(encoding='utf-8').splitlines() if line] if p.exists() else []
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def grade(root):
    p = read(root/'protocol.json')
    assert (root/'result.json').exists(), 'Grade only settled runs'
    assert not p.get('transportCheckOnly'), 'Synthetic transport is not a model benchmark'
    is_paw = p.get('taskVariant') == 'workflow'
    assert is_paw or p.get('mode') == 'workflow'
    key = 'legacy/benchmarks/desktop-harness-ab/verify-workflow.mjs' if is_paw else 'verify-workflow.mjs'
    verifier = root/'source-snapshot'/key
    assert digest(verifier) == p['sourceHashes'][key], 'Frozen verifier hash mismatch'
    workspace = pathlib.Path(p['workspaceRoot']).resolve()
    image = p['isolation']['imageId']
    hashes = {}
    for f in workspace.rglob('*'):
        rel = f.relative_to(workspace)
        if f.is_file() and not any(x.startswith('.') for x in rel.parts): hashes[rel.as_posix()] = digest(f)

    def run(command, mount, independent=False):
        name = 'paw-threeway-grade-'+uuid.uuid4().hex[:12]
        args = ['docker','run','--rm','--name',name,'--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1024m','--cpus','2','--pids-limit','128','--tmpfs','/tmp:exec,nosuid,size=256m,mode=1777','-e','HOME=/tmp/home','-e','npm_config_cache=/tmp/npm-cache','-w','/workspace','--mount',f'type=bind,source={mount},target=/workspace'+(',readonly' if independent else '')]
        if not is_paw: args += ['--user','1000:1000']
        if independent: args += ['--mount',f'type=bind,source={verifier},target=/verifier.mjs,readonly']
        try:
            r = subprocess.run(args+[image,*command],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=120,creationflags=FLAGS)
            return {'exitCode':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
        except subprocess.TimeoutExpired as e:
            return {'exitCode':None,'status':'timeout','stdout':(e.stdout or b'').decode('utf-8','replace') if isinstance(e.stdout,bytes) else e.stdout or ''}
        finally: subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,creationflags=FLAGS)

    # Hidden acceptance always runs first against the immutable original delivery.
    external = run(['node','/verifier.mjs','/workspace'],workspace,True)
    functional = json.loads(external['stdout']) if external['exitCode']==0 else {'passed':0,'total':34,'graderError':external}
    copy = pathlib.Path(tempfile.mkdtemp(prefix='paw-threeway-selftest-')).resolve()
    try:
        shutil.copytree(workspace,copy,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.git','.paw','.claude','.zcode','node_modules'))
        try: package = read(copy/'package.json')
        except (OSError,ValueError): package = {}
        own = run(['npm','test'],copy) if package.get('scripts',{}).get('test') else {'exitCode':None,'status':'missing','stdout':''}
        discovered = run(['node','--test'],copy) if own.get('status')=='missing' and any((copy/'test').glob('*.test.js')) else None
        output = own.get('stdout','')
        own['counts'] = {name:int(found[-1]) for name in ['tests','pass','fail','skipped'] if (found:=re.findall(r'(?:#|ℹ)\s+'+name+r'\s+(\d+)',output))}
    finally:
        assert copy.parent == pathlib.Path(tempfile.gettempdir()).resolve() and copy.name.startswith('paw-threeway-selftest-')
        shutil.rmtree(copy)
    assert all(digest(workspace/rel)==h for rel,h in hashes.items()), 'Original delivery changed during grading'
    result = {'functional':functional,'ownTests':own,'discoveredTestsDiagnostic':discovered,'artifactHashes':hashes,'goalHash':hashlib.sha256(p['goal'].encode()).hexdigest(),'verifierHash':digest(verifier),'requirementsPreserved':(workspace/'REQUIREMENTS.md').read_text(encoding='utf-8')==p['goal'],'dependencies':{k:package.get(k,{}) for k in ['dependencies','devDependencies']}}
    events = rows(root,'events.jsonl')
    wire = rows(root,'wire.jsonl')
    settled = read(root/'result.json')
    if is_paw:
        spec = importlib.util.spec_from_file_location('phase_cost',HERE/'phase-cost-report.py')
        cost = importlib.util.module_from_spec(spec); spec.loader.exec_module(cost)
        phase = cost.report(root)
        totals = phase['totals']
        result['usage'] = {'inputTokens':totals.get('promptTokens',0),'outputTokens':totals.get('completionTokens',0),'totalTokens':totals.get('totalTokens',0),'cacheReadTokens':totals.get('cachedPromptTokens',0),'uncachedInputTokens':totals.get('cacheMissPromptTokens',0),'requestsWithoutUsage':totals.get('requestsWithoutUsage',0),'requestsWithoutCacheUsage':totals.get('requestsWithoutCacheUsage',0)}
        result['phases'] = phase['phases']
        timing = read(root/'verification.json')
        result.update(seconds=timing['seconds'],physicalRequests=timing['physicalRequests'])
        if p.get('experimentKind') == 'recorded_root_live_audit':
            mixed = read(root/'audit-live.json')
            result.update(experimentKind=p['experimentKind'], physicalRequests=mixed['liveAuditRequests'],
                          replayedRequests=mixed['rootReplayedRequests'])
        try: completion=json.loads(settled.get('text','{}'))
        except ValueError: completion={}
        result['completion'] = completion
        result['completed'] = settled.get('ok') is True and completion.get('status')=='completed' and completion.get('acceptance')=='verified'
        def first(pred): return next(((r['at']-p['startedAt'])/1000 for r in events if pred(r.get('event',{}))),None)
        result['firstToolSeconds']=first(lambda e:e.get('type')=='tool.call')
        result['firstSuccessfulWriteSeconds']=first(lambda e:e.get('type')=='tool.result' and e.get('ok') and e.get('tool') in ['workspace_write_file','workspace_edit_file','workspace_apply_patch'])
    else:
        counts=collections.Counter(); request_rows=[]; first_wire_tool=None
        for req in [w for w in wire if w['type']=='request' and w.get('route')=='/v1/messages']:
            raw=root/'relay'/f"{req['id']}.body"
            sse=[]
            for line in raw.read_text(encoding='utf-8',errors='replace').splitlines() if raw.exists() else []:
                if line.startswith('data:'):
                    try:sse.append(json.loads(line[5:].strip()))
                    except ValueError:pass
            # ZCode emits one final pretty JSON object, not streaming tool events.
            # Locate tool block completion in provider bytes; label separately from execution.
            if first_wire_tool is None and raw.exists():
                consumed=0;tool_indexes=set()
                for line in raw.read_bytes().splitlines(keepends=True):
                    consumed+=len(line)
                    if not line.startswith(b'data:'):continue
                    try:e=json.loads(line[5:])
                    except ValueError:continue
                    if e.get('type')=='content_block_start' and e.get('content_block',{}).get('type')=='tool_use':tool_indexes.add(e['index'])
                    if e.get('type')=='content_block_stop' and e.get('index') in tool_indexes:
                        received=0
                        for w in wire:
                            if w['id']==req['id'] and w['type']=='chunk':
                                received+=w['bytes']
                                if received>=consumed:first_wire_tool=(w['at']-p['startedAt'])/1000;break
                        break
            initial=next((e['message'] for e in sse if e.get('type')=='message_start'),{})
            usage=dict(initial.get('usage') or {})
            # Usage deltas are cumulative snapshots, so merge last values, never sum updates.
            final_usage=False
            for e in sse:
                if e.get('type')=='message_delta' and e.get('usage'):
                    usage.update(e['usage']);final_usage=True
            known=final_usage and isinstance(usage.get('input_tokens'),int) and isinstance(usage.get('output_tokens'),int)
            if known:
                cached=usage.get('cache_read_input_tokens',0);created=usage.get('cache_creation_input_tokens',0)
                counts.update(inputTokens=usage['input_tokens']+cached+created,outputTokens=usage['output_tokens'],totalTokens=usage['input_tokens']+cached+created+usage['output_tokens'],uncachedInputTokens=usage['input_tokens'],cacheReadTokens=cached,cacheCreationTokens=created)
                if 'cache_read_input_tokens' not in usage: counts['requestsWithoutCacheUsage']+=1
            else: counts['requestsWithoutUsage']+=1
            request_rows.append({'id':req['id'],'usage':usage,'usageComplete':known,'responseModel':initial.get('model'),'thinking':req.get('thinking'),'output_config':req.get('output_config')})
        result['usage']=dict(counts);result['requestUsage']=request_rows
        result.update(seconds=settled['seconds'],physicalRequests=settled['physicalRequests'])
        final=next((e['event'] for e in reversed(events) if e.get('event',{}).get('type')=='result'),None)
        result['finalEvent']=final
        if p.get('zcodeVersion'):
            try:final=read(root/'stdout.jsonl')
            except (OSError,ValueError):final=None
            result['finalEvent']=final
            completion_ok=bool(final and final.get('projection',{}).get('status')=='idle' and final.get('response'))
        else:completion_ok=bool(final and final.get('subtype')=='success' and not final.get('is_error'))
        result['completed']=settled.get('exitCode')==0 and not settled.get('timedOut') and completion_ok
        tools=[];responses={}
        for row in events:
            e=row.get('event',{});content=e.get('message',{}).get('content',[])
            for b in content if isinstance(content,list) else []:
                if b.get('type')=='tool_use':tools.append((row['at'],b.get('name'),b.get('id')))
                if b.get('type')=='tool_result':responses[b.get('tool_use_id')]=(row['at'],b.get('is_error',False))
        result['firstToolSeconds']=(tools[0][0]-p['startedAt'])/1000 if tools else None
        result['firstSuccessfulWriteSeconds']=next(((responses[id][0]-p['startedAt'])/1000 for _,name,id in tools if name in ['Write','Edit','write_file','edit_file'] and id in responses and not responses[id][1]),None)
        result['firstModelToolRequestSeconds']=first_wire_tool
        if settled.get('firstProductWriteMs') is not None:result['firstGeneratedFileSeconds']=settled['firstProductWriteMs']/1000
    (root/'threeway-grade.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return {k:result[k] for k in ['seconds','physicalRequests','usage','completed','functional','firstToolSeconds','firstSuccessfulWriteSeconds']} | {'ownTestsExit':own['exitCode'],'ownTestCounts':own['counts']}

if __name__=='__main__':
    for arg in sys.argv[1:]: print(json.dumps({'run':arg,**grade(pathlib.Path(arg).resolve())},ensure_ascii=False))
