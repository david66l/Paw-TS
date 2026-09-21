"""Calibrate the frozen independent grader with a reference and deliberate defects."""
import hashlib,json,pathlib,shutil,subprocess,tempfile,uuid,sys
base=pathlib.Path(__file__).resolve().parent
out=pathlib.Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
verifier=base/'verify-workflow.mjs'
variants={'reference':None,'stale-token-accepted':('j.leaseToken!==token||',''),
          'expiry-boundary-off-by-one':('now>=j.leaseUntil','now>j.leaseUntil'),
          'shared-mutable-state':('const copy=x=>structuredClone(x)','const copy=x=>x')}
results=[]
for label,change in variants.items():
    root=pathlib.Path(tempfile.mkdtemp(prefix='paw-workflow-calibration-'))
    try:
        shutil.copytree(base/'fixtures/workflow-reference',root,dirs_exist_ok=True)
        if change:
            p=root/'src/queue.js';s=p.read_text(encoding='utf-8');assert change[0] in s;p.write_text(s.replace(*change),encoding='utf-8')
        name='paw-workflow-calibrate-'+uuid.uuid4().hex[:10]
        args=['docker','run','--rm','--name',name,'--pull','never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','1024m','--cpus','2','--pids-limit','128','--tmpfs','/tmp:exec,nosuid,size=256m','-w','/workspace','--mount',f'type=bind,source={root},target=/workspace,readonly','--mount',f'type=bind,source={verifier},target=/verifier.mjs,readonly','paw-claude-bench:2.1.224','node','/verifier.mjs','/workspace']
        try:
            r=subprocess.run(args,capture_output=True,text=True,encoding='utf-8',timeout=90,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            assert r.returncode==0,r.stderr
            grade=json.loads(r.stdout);results.append({'variant':label,**grade})
            assert (grade['passed']==grade['total'])==(change is None),label
        finally:subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=15,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    finally:
        assert root.parent.resolve()==pathlib.Path(tempfile.gettempdir()).resolve() and root.name.startswith('paw-workflow-calibration-')
        shutil.rmtree(root)
report={'schemaVersion':'paw.workflow-calibration.v1','verifierSha256':hashlib.sha256(verifier.read_bytes()).hexdigest(),'results':results}
(out/'calibration.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps([{'variant':r['variant'],'passed':r['passed'],'total':r['total']} for r in results]))
