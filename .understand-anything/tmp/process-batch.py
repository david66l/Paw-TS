import json, sys, os

batch_idx = sys.argv[1]
project_root = "/Users/Zhuanz/Documents/CS/项目/paw-ts"

# Read extraction results
extract_path = f"{project_root}/.understand-anything/tmp/ua-file-extract-results-{batch_idx}.json"
with open(extract_path) as f:
    extract = json.load(f)

# Read batch data for batchImportData
batch_path = f"{project_root}/.understand-anything/tmp/batches/{batch_idx}.json"
with open(batch_path) as f:
    batch_data = json.load(f)

batch_import_data = batch_data.get("batchImportData", {})
neighbor_map = batch_data.get("neighborMap", {})

# Dump a summary of what we have
print(f"Batch {batch_idx}: {len(extract['results'])} results")
for r in extract['results']:
    funcs = len(r.get('functions', []))
    classes = len(r.get('classes', []))
    exports = len(r.get('exports', []))
    imports = r.get('metrics', {}).get('importCount', 0)
    path = r['path']
    print(f"  {path}: {funcs}f {classes}c {exports}e {imports}i lines={r.get('nonEmptyLines','?')}")
