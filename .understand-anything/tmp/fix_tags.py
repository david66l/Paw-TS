import json, os, sys

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'intermediate')

def improve_tags(nodes):
    for n in nodes:
        tags = n['tags']
        path = n.get('filePath', '')
        while len(tags) < 3:
            if n['type'] == 'function':
                if 'utility' not in tags: tags.append('utility')
            elif n['type'] == 'class':
                if 'component' not in tags: tags.append('component')
            else:
                found = False
                for mod in ['memory','agent','evaluation','core','workspace']:
                    if mod in path and mod not in tags:
                        tags.append(mod if mod != 'evaluation' else 'evaluation')
                        found = True
                        break
                if not found and 'utility' not in tags:
                    tags.append('utility')
        seen = set()
        dedup = []
        for t in tags:
            if t not in seen:
                seen.add(t); dedup.append(t)
        n['tags'] = dedup[:5]

for bi in range(1, 7):
    fname = os.path.join(out_dir, f'batch-{bi}.json')
    files_to_process = []
    if os.path.exists(fname):
        files_to_process.append(fname)
    else:
        files_to_process.extend(sorted([os.path.join(out_dir, f) for f in os.listdir(out_dir) if f'batch-{bi}-part-' in f]))
    for pf in files_to_process:
        with open(pf) as f: d = json.load(f)
        improve_tags(d['nodes'])
        with open(pf, 'w') as f: json.dump(d, f, indent=2, ensure_ascii=False)

for bi in range(1, 7):
    fname = os.path.join(out_dir, f'batch-{bi}.json')
    if not os.path.exists(fname):
        parts = sorted([f for f in os.listdir(out_dir) if f'batch-{bi}-part-' in f])
        fname = os.path.join(out_dir, parts[0])
    with open(fname) as f: d = json.load(f)
    bad = sum(1 for n in d['nodes'] if len(n['tags']) < 3)
    print(f'Batch {bi}: {bad} low-tag nodes (out of {len(d["nodes"])})')
print('Done!')
