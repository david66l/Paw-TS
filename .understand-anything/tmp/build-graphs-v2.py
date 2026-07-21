import json, os, sys

project_root = "/Users/Zhuanz/Documents/CS/项目/paw-ts"

# ---- Refined helper functions ----

def is_test(path):
    fname = os.path.basename(path).lower()
    if "test/" in path or "tests/" in path:
        return True
    for p in [".test.", ".spec.", "/test_", "_test."]:
        if p in path.lower():
            return True
    return False

def is_benchmark(path):
    return "benchmark" in path.lower() or "benchmarks" in path.lower()

def is_barrel(results):
    funcs = results.get('functions', [])
    classes = results.get('classes', [])
    exports = results.get('exports', [])
    return len(exports) > 3 and len(funcs) + len(classes) < 2

def assign_tags(path, results, file_category):
    tags = []
    basename = os.path.basename(path).lower()
    funcs = results.get('functions', [])
    classes = results.get('classes', [])
    exports = results.get('exports', [])

    # Test files (excluding benchmarks)
    if is_test(path) and not is_benchmark(path):
        tags.append("test")
        if "e2e" in path:
            tags.append("integration-test")
        elif "integration" in path:
            tags.append("integration-test")
        elif "fixtures" in basename:
            tags.append("test-fixture")
        else:
            tags.append("unit-test")
    
    # Benchmark files
    if is_benchmark(path):
        tags.append("benchmark")
    
    # Barrel files
    if is_barrel(results) and not is_test(path):
        tags.append("barrel")
        if "index.ts" in basename or "index.js" in basename:
            tags.append("entry-point")
    
    # Entry point
    if basename in ["index.ts", "index.js"] and len(exports) > 3:
        if "entry-point" not in tags:
            tags.append("entry-point")

    # Source file tags
    if not is_test(path) and not is_benchmark(path):
        dir_parts = path.split('/')
        # Memory module
        if 'memory' in path:
            tags.append("memory")
            if 'retriev' in basename or 'retriev' in path:
                tags.append("retrieval")
            if 'embedding' in basename:
                tags.append("embeddings")
            if 'scorer' in basename:
                tags.append("scoring")
            if 'tokenizer' in basename:
                tags.append("tokenization")
            if 'auto-memory' in basename:
                tags.append("auto-memory")
            if 'archive' in basename:
                tags.append("archiving")
            if 'reflect' in basename:
                tags.append("reflection")
            if 'query' in basename:
                tags.append("query-building")
            if 'session' in basename:
                tags.append("session-management")
            if 'unified' in basename:
                tags.append("data-store")
            if 'cascade' in basename:
                tags.append("retrieval-strategy")
            if 'select' in basename:
                tags.append("selection")
            if 'record' in basename:
                tags.append("data-model")
                
        # Agent module
        if 'agent' in path:
            tags.append("agent")
            if 'orchestrator' in path and 'orchestrator.ts' == basename:
                tags.append("orchestration")
                tags.append("core-engine")
            elif 'orchestrator' in path:
                tags.append("orchestration")
            if 'compress' in basename:
                tags.append("compression")
            if 'extract' in basename:
                tags.append("extraction")
            if 'circuit' in basename:
                tags.append("resilience")
            if 'sandbox' in basename:
                tags.append("sandbox")
            if 'resolve' in basename:
                tags.append("configuration")
            if 'session' in basename:
                tags.append("session-management")
            if 'stub' in basename:
                tags.append("stub")
            if 'settings' in basename:
                tags.append("configuration")
            if 'system-prompt' in basename:
                tags.append("prompt-engineering")
            if 'complete' in basename:
                tags.append("llm-utility")
            if 'factory' in basename:
                tags.append("factory")
            if 'action-handler' in basename:
                tags.append("action-handling")
            if 'agent-args' in basename:
                tags.append("parameter-building")
            if 'agent-group' in basename:
                tags.append("group-management")
            if 'context-summariz' in basename:
                tags.append("summarization")
            if 'tool-runner' in basename:
                tags.append("tool-execution")
            if 'types.ts' in basename:
                tags.append("type-definition")
            if 'parse' in basename:
                tags.append("parsing")
            if 'conversation' in basename:
                tags.append("data-transformation")
            if 'launcher' in basename:
                tags.append("sub-agent")
            if 'tool-result' in basename:
                tags.append("tool-results")
            
        # Eval module
        if 'eval' in path:
            tags.append("evaluation")
            if 'scorer' in path:
                tags.append("scoring")
            if 'test-suite' in path or 'builtin' in path:
                tags.append("test-suite")
            if 'cli' in path:
                tags.append("cli")
            if 'runner' in basename:
                tags.append("orchestration")
            if 'record' in basename:
                tags.append("data-model")
            if 'settings' in basename:
                tags.append("configuration")
            if 'collector' in basename:
                tags.append("data-collection")
            if 'reporter' in basename:
                tags.append("reporting")
            if 'aggregator' in basename:
                tags.append("aggregation")
            if 'llm-scorer' in basename:
                tags.append("llm-judge")
            if 'rule-scorer' in basename:
                tags.append("rule-based")
            if 'loader' in basename:
                tags.append("loading")
            if 'training' in basename:
                tags.append("data-export")
            if 'types.ts' in basename:
                tags.append("type-definition")
            if 'adversarial' in basename:
                tags.append("adversarial")
                tags.append("security")
            if 'code-gen' in basename:
                tags.append("code-generation")
            if 'context-mgmt' in basename:
                tags.append("context")
            if 'core-tools' in basename:
                tags.append("tools")
            if 'high-frequency' in basename:
                tags.append("high-frequency")
            if 'memory-retrieval' in basename:
                tags.append("memory")
            if 'multi-step' in basename:
                tags.append("multi-step")
            if 'shell-safety' in basename:
                tags.append("shell")
                tags.append("security")
            
        # Core module
        if 'core' in path:
            tags.append("core")
            if 'context' in path:
                tags.append("context")
                if 'compactor' in basename:
                    tags.append("compression")
                if 'manager' in basename:
                    tags.append("context-management")
                if 'policy' in basename:
                    tags.append("policy")
                if 'pruner' in basename:
                    tags.append("pruning")
            if 'token' in basename:
                tags.append("tokenization")
            if 'todo' in basename:
                tags.append("task-management")
            if 'sanitiz' in basename:
                tags.append("security")
            if 'tool-result' in path:
                tags.append("tool-results")
            if 'format' in basename:
                tags.append("formatting")
            if 'storage' in basename:
                tags.append("persistence")
            if 'app-state' in basename:
                tags.append("state-management")
            if 'eval-hooks' in basename:
                tags.append("hooks")
            
        # Workspace module
        if 'workspace' in path:
            tags.append("workspace")
            if 'files' in path:
                tags.append("file-operations")
            if 'git' in basename:
                tags.append("git")
            if 'notebook' in basename:
                tags.append("notebook")
            if 'patch' in basename:
                tags.append("patch")
            if 'mention' in basename:
                tags.append("mention")
            if 'path-guard' in basename:
                tags.append("security")
            if 'project-context' in basename:
                tags.append("context")
                tags.append("auto-detection")
    
    # Benchmarks
    if is_benchmark(path):
        if 'adapter' in basename:
            tags.append("adapter")
        if 'longbench' in path:
            tags.append("long-context")
    
    # Deduplicate and limit
    seen = set()
    unique = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            unique.append(t)
    
    # Ensure minimum 3 tags
    if len(unique) < 3:
        # Add fallback based on module
        fallbacks = []
        if 'memory' in path:
            fallbacks = ["memory", "data-model", "utilities"]
        elif 'agent' in path:
            fallbacks = ["agent", "utilities"]
        elif 'eval' in path:
            fallbacks = ["evaluation", "utilities"]
        elif 'core' in path:
            fallbacks = ["core", "infrastructure"]
        elif 'workspace' in path:
            fallbacks = ["workspace", "tools"]
        elif 'benchmark' in path or 'longbench' in path:
            fallbacks = ["benchmark", "performance"]
        else:
            fallbacks = ["utilities"]
        
        for fb in fallbacks:
            if fb not in seen and len(unique) < 3:
                unique.append(fb)
                seen.add(fb)
    
    return unique[:5]

def complexity_from_lines(lines, funcs, classes):
    n = lines if lines else 0
    if n < 50:
        return "simple"
    elif n < 200:
        return "moderate"
    else:
        return "complex"

def function_summary(fn, path):
    name = fn.get('name', '')
    params = ', '.join(fn.get('params', [])) if fn.get('params') else 'no params'
    start = fn.get('startLine', '?')
    end = fn.get('endLine', '?')
    size = end - start if isinstance(start, int) and isinstance(end, int) else '?'
    basename = os.path.basename(path)
    
    if is_test(path):
        return f"测试用例：{name}({params})，{size} 行。"
    
    context = ""
    lname = name.lower()
    if 'format' in lname: context = "格式化"
    elif 'parse' in lname: context = "解析"
    elif 'create' in lname or 'build' in lname: context = "构建"
    elif 'get' in lname or 'fetch' in lname or 'retrieve' in lname: context = "检索"
    elif 'set' in lname: context = "设置"
    elif 'resolve' in lname: context = "解析配置"
    elif 'run' in lname or 'execute' in lname: context = "执行"
    elif 'compute' in lname or 'calculate' in lname or 'score' in lname: context = "计算/评分"
    elif 'save' in lname or 'store' in lname or 'persist' in lname: context = "存储"
    elif 'load' in lname: context = "加载"
    elif 'init' in lname: context = "初始化"
    elif 'validate' in lname or 'check' in lname or 'guard' in lname: context = "验证"
    elif 'sanitize' in lname: context = "安全清洗"
    elif 'tokeni' in lname: context = "分词"
    elif 'embed' in lname: context = "向量嵌入"
    elif 'extract' in lname: context = "提取"
    elif 'reflect' in lname: context = "反思"
    elif 'summar' in lname or 'compact' in lname: context = "摘要/压缩"
    elif 'select' in lname or 'filter' in lname: context = "选择/过滤"
    elif 'archive' in lname: context = "归档"
    elif 'estimate' in lname: context = "估算"
    elif 'launch' in lname: context = "启动"
    elif 'approv' in lname: context = "审批"
    
    if context:
        return f"{context}函数 {name}({params})，{size} 行。"
    return f"函数 {name}({params})，{size} 行。"

def class_summary(cls, path):
    name = cls.get('name', '')
    methods = cls.get('methods', [])
    properties = cls.get('properties', [])
    start = cls.get('startLine', '?')
    end = cls.get('endLine', '?')
    size = end - start if isinstance(start, int) and isinstance(end, int) else '?'
    
    if is_test(path):
        return f"测试类 {name}，{len(methods)} 个测试方法，{size} 行。"
    return f"类 {name}，{len(methods)} 个方法、{len(properties)} 个属性，{size} 行。"

def file_summary(path, results, file_category):
    basename = os.path.basename(path)
    funcs = len(results.get('functions', []))
    classes = len(results.get('classes', []))
    exports = len(results.get('exports', []))
    lines = results.get('nonEmptyLines', 0)
    
    if is_test(path) and not is_benchmark(path):
        if "e2e" in path:
            return f"端到端测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
        elif "integration" in path:
            return f"集成测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
        elif "fixtures" in basename:
            return f"测试夹具文件，提供共享测试数据和工具函数。"
        else:
            return f"单元测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
    
    if is_benchmark(path):
        if 'adapter' in basename:
            return f"基准测试适配器，{funcs} 个函数，{lines} 行。"
        return f"基准测试文件，{funcs} 个测试案例，{lines} 行。"
    
    if is_barrel(results):
        return f"模块 barrel 入口文件，重新导出 {exports} 个公共符号。"
    
    # Source files - use general summary
    suffix = f"，{funcs} 个函数"
    if classes > 0:
        suffix += f"，{classes} 个类"
    suffix += f"，{lines} 行。"
    return f"TypeScript 源文件{suffix}"

def function_tags(fn, path):
    tags = []
    name = fn.get('name', '')
    if any(k in name.lower() for k in ['test', 'it ', 'describe']):
        tags.append("test")
    if 'format' in name.lower(): tags.append("formatting")
    if 'parse' in name.lower(): tags.append("parsing")
    if 'retrieve' in name.lower(): tags.append("retrieval")
    if 'embed' in name.lower(): tags.append("embeddings")
    if 'score' in name.lower(): tags.append("scoring")
    if 'token' in name.lower(): tags.append("tokenization")
    if 'summar' in name.lower() or 'compact' in name.lower(): tags.append("summarization")
    if 'extract' in name.lower(): tags.append("extraction")
    if 'create' in name.lower() or 'build' in name.lower(): tags.append("factory")
    if len(tags) < 2:
        if is_test(path): tags.append("test")
        elif is_benchmark(path): tags.append("benchmark")
        else: tags.append("utility")
    return tags[:4]

def class_tags(cls, path):
    tags = []
    name = cls.get('name', '')
    if 'test' in name.lower(): tags.append("test")
    if 'handler' in name.lower(): tags.append("api-handler")
    if 'store' in name.lower() or 'manager' in name.lower(): tags.append("state-management")
    if 'cache' in name.lower(): tags.append("caching")
    if len(tags) < 2:
        if is_test(path): tags.append("test")
        elif is_benchmark(path): tags.append("benchmark")
        else: tags.append("core")
    return tags[:4]

def should_emit_function(fn, path, exports):
    name = fn.get('name', '')
    start = fn.get('startLine', 0)
    end = fn.get('endLine', 0)
    size = end - start if isinstance(start, int) and isinstance(end, int) else 0
    
    if size < 10:
        return False
    for e in exports:
        if e.get('name') == name:
            return True
    return size >= 15

def should_emit_class(cls, path, exports):
    name = cls.get('name', '')
    start = cls.get('startLine', 0)
    end = cls.get('endLine', 0)
    methods = cls.get('methods', [])
    size = end - start if isinstance(start, int) and isinstance(end, int) else 0
    
    if size < 20 and len(methods) < 2:
        return False
    for e in exports:
        if e.get('name') == name:
            return True
    return size >= 20

# ---- Main processing ----

def process_batch(batch_idx):
    print(f"\n--- Processing batch {batch_idx} ---", file=sys.stderr)
    
    extract_path = f"{project_root}/.understand-anything/tmp/ua-file-extract-results-{batch_idx}.json"
    with open(extract_path) as f:
        extract = json.load(f)
    
    batch_path = f"{project_root}/.understand-anything/tmp/batches/{batch_idx}.json"
    with open(batch_path) as f:
        batch_data = json.load(f)
    
    batch_import_data = batch_data.get("batchImportData", {})
    
    nodes = []
    edges = []
    
    for r in extract['results']:
        path = r['path']
        lang = r.get('language', 'typescript')
        cat = r.get('fileCategory', 'code')
        lines = r.get('nonEmptyLines', 0)
        funcs = r.get('functions', [])
        classes = r.get('classes', [])
        exports = r.get('exports', [])
        metrics = r.get('metrics', {})
        
        type_map = {'code': 'file', 'config': 'config', 'docs': 'document', 
                     'infra': 'service', 'data': 'schema', 'script': 'file', 'markup': 'file'}
        node_type = type_map.get(cat, 'file')
        
        node = {
            "id": f"{node_type}:{path}",
            "type": node_type,
            "name": os.path.basename(path),
            "filePath": path,
            "summary": file_summary(path, r, cat),
            "tags": assign_tags(path, r, cat),
            "complexity": complexity_from_lines(lines, funcs, classes)
        }
        nodes.append(node)
        
        # Function nodes
        for fn in funcs:
            if should_emit_function(fn, path, exports):
                fnode = {
                    "id": f"function:{path}:{fn['name']}",
                    "type": "function",
                    "name": fn['name'],
                    "filePath": path,
                    "lineRange": [fn.get('startLine', 0), fn.get('endLine', 0)],
                    "summary": function_summary(fn, path),
                    "tags": function_tags(fn, path),
                    "complexity": complexity_from_lines(fn.get('endLine', 0) - fn.get('startLine', 0), [], [])
                }
                nodes.append(fnode)
                edges.append({
                    "source": f"{node_type}:{path}",
                    "target": f"function:{path}:{fn['name']}",
                    "type": "contains",
                    "direction": "forward",
                    "weight": 1.0
                })
        
        # Class nodes
        for cls in classes:
            if should_emit_class(cls, path, exports):
                cnode = {
                    "id": f"class:{path}:{cls['name']}",
                    "type": "class",
                    "name": cls['name'],
                    "filePath": path,
                    "lineRange": [cls.get('startLine', 0), cls.get('endLine', 0)],
                    "summary": class_summary(cls, path),
                    "tags": class_tags(cls, path),
                    "complexity": complexity_from_lines(cls.get('endLine', 0) - cls.get('startLine', 0), [], [])
                }
                nodes.append(cnode)
                edges.append({
                    "source": f"{node_type}:{path}",
                    "target": f"class:{path}:{cls['name']}",
                    "type": "contains",
                    "direction": "forward",
                    "weight": 1.0
                })
        
        # Export edges
        func_names = [f['name'] for f in funcs if should_emit_function(f, path, exports)]
        class_names = [c['name'] for c in classes if should_emit_class(c, path, exports)]
        for e in exports:
            ename = e.get('name', '')
            if ename in func_names:
                edges.append({
                    "source": f"{node_type}:{path}",
                    "target": f"function:{path}:{ename}",
                    "type": "exports",
                    "direction": "forward",
                    "weight": 0.8
                })
            elif ename in class_names:
                edges.append({
                    "source": f"{node_type}:{path}",
                    "target": f"class:{path}:{ename}",
                    "type": "exports",
                    "direction": "forward",
                    "weight": 0.8
                })
        
        # Import edges
        imports_list = batch_import_data.get(path, [])
        for imp_path in imports_list:
            edges.append({
                "source": f"{node_type}:{path}",
                "target": f"file:{imp_path}",
                "type": "imports",
                "direction": "forward",
                "weight": 0.7
            })
        
        # Test / benchmark edges (tested_by)
        if is_test(path) and not is_benchmark(path):
            for imp_path in imports_list:
                if not is_test(imp_path) and not is_benchmark(imp_path) and 'fixture' not in imp_path.lower() and imp_path.startswith('packages/'):
                    edges.append({
                        "source": f"file:{imp_path}",
                        "target": f"{node_type}:{path}",
                        "type": "tested_by",
                        "direction": "forward",
                        "weight": 0.5
                    })
        
        # Call graph edges
        call_graph = r.get('callGraph', [])
        for cg in call_graph:
            caller = cg.get('caller', '')
            callee = cg.get('callee', '')
            if caller in func_names and callee in func_names:
                edges.append({
                    "source": f"function:{path}:{caller}",
                    "target": f"function:{path}:{callee}",
                    "type": "calls",
                    "direction": "forward",
                    "weight": 0.8
                })
    
    print(f"  Total nodes: {len(nodes)}, Total edges: {len(edges)}", file=sys.stderr)
    
    # Write output
    out_dir = f"{project_root}/.understand-anything/intermediate"
    os.makedirs(out_dir, exist_ok=True)
    
    if len(nodes) <= 60 and len(edges) <= 120:
        out_path = f"{out_dir}/batch-{batch_idx}.json"
        with open(out_path, 'w') as f:
            json.dump({"nodes": nodes, "edges": edges}, f, indent=2, ensure_ascii=False)
        print(f"  Single file -> {out_path}", file=sys.stderr)
        return 1, len(nodes), len(edges)
    else:
        file_paths = sorted(set(n.get('filePath', '') for n in nodes if n.get('filePath')))
        num_parts = max(2, (max(len(nodes) // 60, len(edges) // 120) + 1))
        chunk_size = max(1, len(file_paths) // num_parts)
        
        for k in range(num_parts):
            start_idx = k * chunk_size
            end_idx = len(file_paths) if k == num_parts - 1 else (k + 1) * chunk_size
            chunk_files = set(file_paths[start_idx:end_idx])
            
            part_nodes = [n for n in nodes if not n.get('filePath') or n['filePath'] in chunk_files]
            node_ids = set(n['id'] for n in part_nodes)
            part_edges = [e for e in edges if e['source'] in node_ids]
            
            out_path = f"{out_dir}/batch-{batch_idx}-part-{k+1}.json"
            with open(out_path, 'w') as f:
                json.dump({"nodes": part_nodes, "edges": part_edges}, f, indent=2, ensure_ascii=False)
            print(f"  Part {k+1}: {len(part_nodes)} nodes, {len(part_edges)} edges", file=sys.stderr)
        
        return num_parts, len(nodes), len(edges)

# Process all
for i in range(1, 7):
    p, n, e = process_batch(i)
    print(f"  Done: batch {i} -> {p} part(s), {n} nodes, {e} edges", file=sys.stderr)
