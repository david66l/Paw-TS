"""Apply documented storage and read-only-copy adjudications to every delivery."""
import hashlib,json,pathlib,subprocess,sys,uuid
base=pathlib.Path(__file__).resolve().parent
verifier=base/'workflow-storage-adjudication.mjs'
for arg in sys.argv[1:]:
    root=pathlib.Path(arg).resolve()
    p=json.loads((root/'protocol.json').read_text(encoding='utf-8'))
    grade=json.loads((root/'threeway-grade.json').read_text(encoding='utf-8'))
    name='paw-storage-review-'+uuid.uuid4().hex[:12]
    args=['docker','run','--rm','--name',name,'--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','64','--tmpfs','/tmp:nosuid,size=64m,mode=1777','--mount',f"type=bind,source={p['workspaceRoot']},target=/workspace,readonly",'--mount',f'type=bind,source={verifier},target=/review.mjs,readonly']
    if p.get('mode')=='workflow':args+=['--user','1000:1000']
    try:
        r=subprocess.run(args+[p['isolation']['imageId'],'node','/review.mjs','/workspace'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        assert r.returncode==0,r.stderr
        review=json.loads(r.stdout)
    finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    review['verifierHash']=hashlib.sha256(verifier.read_bytes()).hexdigest()
    isolation_verifier=base/'workflow-isolation-adjudication.mjs'
    isolation_args=[a.replace(str(verifier),str(isolation_verifier)) for a in args]
    try:
        r=subprocess.run(isolation_args+[p['isolation']['imageId'],'node','/review.mjs','/workspace'],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        assert r.returncode==0,r.stderr
        isolation_review=json.loads(r.stdout)
        isolation_review['verifierHash']=hashlib.sha256(isolation_verifier.read_bytes()).hexdigest()
    finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    checks=[dict(c) for c in grade['functional']['checks']]
    for c in checks:
        if c['name']=='persistent round-trip and temp cleanup':
            c['originalPass']=c['pass'];c['pass']=review['passed']
            if review['passed']:c.pop('error',None)
            else:c['error']=review.get('error','supplemental check failed')
        for supplemental in isolation_review['checks']:
            if c['name']==supplemental['name']:
                c['originalPass']=c['pass'];c['pass']=supplemental['pass']
                if supplemental['pass']:c.pop('error',None)
                else:c['error']=supplemental['error']
    grade['storageAdjudication']=review
    grade['isolationAdjudication']=isolation_review
    grade['adjudicatedFunctional']={'passed':sum(c['pass'] for c in checks),'total':len(checks),'checks':checks}
    (root/'threeway-grade.json').write_text(json.dumps(grade,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'run':root.name,'rawPassed':grade['functional']['passed'],'reviewedPassed':grade['adjudicatedFunctional']['passed'],'total':len(checks)}))
