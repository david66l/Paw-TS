import json, os

out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'intermediate')

count = 0
for fname in sorted(os.listdir(out_dir)):
    if not fname.startswith('batch-'):
        continue
    bn = fname.split('-')[1]
    if not bn.isdigit() or int(bn) > 6:
        continue

    fp = os.path.join(out_dir, fname)
    with open(fp) as f:
        d = json.load(f)

    for n in d['nodes']:
        t = list(set(n['tags']))
        path = n.get('filePath', '')
        while len(t) < 3:
            if n['type'] == 'function':
                t.append('utility')
            elif n['type'] == 'class':
                t.append('component')
            else:
                added = False
                for mod in ['memory', 'agent', 'evaluation', 'core', 'workspace']:
                    if mod in path and mod not in t:
                        t.append(mod)
                        added = True
                        break
                if not added:
                    t.append('utility')
            t = list(set(t))
        n['tags'] = t[:5]

    with open(fp, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    count += 1

print(f'Fixed {count} files')

# Verification
for bi in range(1, 7):
    total_nodes = 0
    low_tags = 0
    for part in sorted(os.listdir(out_dir)):
        if f'batch-{bi}-part-' not in part and part != f'batch-{bi}.json':
            continue
        fn2 = f'batch-{bi}.json'
        if os.path.exists(os.path.join(out_dir, fn2)) and part != fn2:
            continue
        fp = os.path.join(out_dir, part)
        with open(fp) as f:
            d = json.load(f)
        total_nodes += len(d['nodes'])
        low_tags += sum(1 for n in d['nodes'] if len(set(n['tags'])) < 3)
    if total_nodes > 0:
        s = 'OK' if low_tags == 0 else str(low_tags) + ' low-tag'
        print(f'Batch {bi}: {total_nodes} nodes, {s}')
