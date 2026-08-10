import json, os, re

TMP = "/Users/Zhuanz/Documents/CS/项目/paw-ts/.understand-anything/tmp"
OUT = "/Users/Zhuanz/Documents/CS/项目/paw-ts/.understand-anything/intermediate"
os.makedirs(OUT, exist_ok=True)

BATCHES = [25, 26, 27, 28, 29, 30, 31]

# Known project files for cross-referencing in summaries
KNOWN_FILES = {
    "packages/core/src/index.ts": "核心模块 barrel 出口",
    "packages/agent/src/index.ts": "Agent 编排模块出口",
    "packages/harness/src/index.ts": "工具执行模块出口",
    "packages/eval/src/index.ts": "评估模块出口",
    "packages/workspace/src/index.ts": "工作区模块出口",
    "packages/settings/src/index.ts": "配置管理模块出口",
    "packages/store/src/index.ts": "存储模块出口",
    "packages/memory/src/project-memory.ts": "项目记忆加载",
    "apps/cli/src/main.ts": "CLI 入口",
}

def guess_name(path):
    return os.path.basename(path) or path

def pick_codefile_tags(path, metrics, exports):
    tags = []
    name = guess_name(path)
    export_count = metrics.get("exportCount", 0)
    
    if ".test." in path or ".spec." in path or "/test/" in path or "test/" in path.split("/")[0]:
        tags.append("test")
    
    if export_count > 50:
        tags.extend(["barrel", "entry-point"])
    elif export_count > 10:
        tags.append("exports")
    
    if "main.ts" in path and "cli" in path:
        tags.append("entry-point")
    if "cli" in path:
        tags.append("cli")
    if "jsx-runtime" in path:
        tags.append("jsx-runtime")
    if "cost-tracker" in path:
        tags.append("cost-tracking")
    if "errors" in path:
        tags.append("error-handling")
    if "find-root" in path:
        tags.append("path-resolution")
    if "/prompt/" in path and path.endswith(".txt"):
        tags.append("system-prompt")
    if "lsp" in path:
        tags.append("lsp")
    if "network" in path:
        tags.append("network-tools")
    if "symbol" in path:
        tags.append("symbol-search")
    if "watch" in path:
        tags.append("file-watcher")
    if "worktree" in path:
        tags.append("git-worktree")
    if "paw-md" in path:
        tags.append("markdown-parser")
    if "root" in path and path.endswith(".ts"):
        tags.append("cli-utility")
    if "download" in path and path.endswith(".py"):
        tags.append("data-download")
    if "generate_stage" in path:
        tags.append("training-data")
    if "run.py" in path and "swe-bench" in path:
        tags.append("benchmark-runner")
    if "benchmark" in path:
        tags.append("benchmark")
    if "adapter" in path:
        tags.append("adapter")
    if "import-skill" in path:
        tags.append("skill-importer")
    if path.endswith(".jsonl"):
        tags.append("training-data")
    
    if not tags:
        tags.append("source-code")
    return tags[:5]

def pick_func_tags(fname, is_exported, path):
    tags = ["function"]
    if is_exported:
        tags.append("exported")
    if fname == "main":
        tags.append("entry-point")
    if fname == "usage":
        tags.append("cli-help")
    if "run" in fname.lower() and not fname.endswith("ner"):
        tags.append("runner")
    return tags

def pick_cls_tags(cname, is_exported, path):
    tags = ["class"]
    if is_exported:
        tags.append("exported")
    if "Orchestrator" in cname or "Agent" in cname:
        tags.append("agent")
    if "Client" in cname:
        tags.append("client")
    if "Tracker" in cname:
        tags.append("tracker")
    if "Watcher" in cname:
        tags.append("watcher")
    if "Store" in cname:
        tags.append("store")
    if "Error" in cname:
        tags.append("error")
    return tags

def docs_summary(path, sections, total_lines):
    name = guess_name(path)
    if sections:
        first = sections[0].get("heading", "")
        count = len(sections)
        return f"包含 {count} 个章节的文档，主题为「{first}」。"
    return f"文档文件，共 {total_lines} 行。"

def docs_tags(path, sections):
    tags = []
    name = guess_name(path)
    
    if "README" in name or "readme" in name.lower():
        tags.append("entry-point")
    if "plan" in name.lower() or "计划" in path or "方案" in path or "PLAN" in name:
        tags.append("planning")
    if "分析" in path or "analysis" in name.lower():
        tags.append("analysis")
    if "架构" in path or "architecture" in name.lower() or "ARCHITECTURE" in name:
        tags.append("architecture")
    if "升级" in path or "upgrade" in name.lower() or "UPGRADE" in name:
        tags.append("upgrade")
    if "微调" in path or "fine" in name.lower():
        tags.append("fine-tuning")
    if "记忆" in path or "memory" in name.lower():
        tags.append("memory")
    if "测试" in path or "test" in name.lower() or "TEST" in name:
        tags.append("testing")
    if "面试" in path or "interview" in name.lower():
        tags.append("interview-prep")
    if "压缩" in path or "compression" in name.lower() or "compact" in name.lower():
        tags.append("context-compression")
    if "ADR" in path or "决策" in path:
        tags.append("adr")
    if "benchmark" in name.lower() or "benchmark" in path.lower() or "BENCHMARK" in name:
        tags.append("benchmark")
    if "eval" in name.lower() or "EVAL" in name or "评估" in path:
        tags.append("evaluation")
    if "对比" in path or path.endswith("对比.md"):
        tags.append("comparison")
    if "缺失" in path or "missing" in name.lower():
        tags.append("gap-analysis")
    if "研究" in path or "research" in path.lower():
        tags.append("research")
    if "演示" in path or "demo" in name.lower() or "golden" in name.lower():
        tags.append("demo")
    if "multi-agent" in name.lower() or "multi-agent" in path.lower():
        tags.append("multi-agent")
    if "数据流" in path or "data-flow" in name.lower():
        tags.append("data-flow")
    if "状态" in path or "state" in name.lower():
        tags.append("state-management")
    if "prompt" in name.lower() and path.endswith(".txt"):
        tags.append("system-prompt")
    
    tags.append("documentation")
    return tags[:5]

for batch_idx in BATCHES:
    with open(f"{TMP}/batches/{batch_idx}.json") as f:
        batch_input = json.load(f)
    with open(f"{TMP}/ua-file-extract-results-{batch_idx}.json") as f:
        extraction = json.load(f)
    
    batch_import_data = batch_input.get("batchImportData", {})
    neighbor_map = batch_input.get("neighborMap", {})
    results = extraction.get("results", [])
    
    nodes = []
    edges = []
    node_ids_set = set()
    
    for r in results:
        path = r["path"]
        file_cat = r.get("fileCategory", "code")
        lang = r.get("language", "unknown")
        total_lines = r.get("totalLines", 0)
        non_empty = r.get("nonEmptyLines", 0)
        metrics = r.get("metrics", {})
        sections = r.get("sections", [])
        
        # Determine node type
        if file_cat == "docs":
            node_type = "document"
        elif file_cat == "config":
            node_type = "config"
        elif file_cat == "infra":
            node_type = "service"
        elif file_cat == "data":
            node_type = "schema"
        else:
            node_type = "file"
        
        # Complexity
        if non_empty == 0:
            complexity = "simple"
        elif non_empty < 50:
            complexity = "simple"
        elif non_empty < 200:
            complexity = "moderate"
        else:
            complexity = "complex"
        
        name = guess_name(path)
        
        # Per-file summary and tags
        if file_cat == "docs":
            summary = docs_summary(path, sections, total_lines)
            tags = docs_tags(path, sections)
        elif file_cat == "config":
            if "package.json" in path:
                summary = f"包配置文件，定义 {name} 对应包的依赖、脚本与模块导出。"
                tags = ["configuration", "package-manager", "build-system"]
            elif "tsconfig" in path:
                summary = "TypeScript 编译器配置，继承基础 tsconfig 并指定编译输入路径。"
                tags = ["configuration", "typescript", "build-system"]
            elif "scan-result.json" in path:
                summary = "项目扫描结果，包含所有文件的清单、语言检测、框架信息与导入映射。"
                tags = ["configuration", "project-scan", "metadata"]
            else:
                summary = f"配置文件，共 {total_lines} 行。"
                tags = ["configuration"]
        else:
            summary = ""
            tags = pick_codefile_tags(path, metrics, r.get("exports", []))
            
            # Special file handling
            if path.endswith(".mmd"):
                summary = "Mermaid 应用架构图，描述系统组件间的拓扑关系与数据流向。"
                tags = ["diagram", "architecture", "mermaid"]
            elif path.endswith("Untitled") or total_lines <= 1:
                summary = "空文件或占位文件。"
                tags = ["placeholder"]
            elif path.endswith(".understandignore"):
                summary = "Understand-Anything 忽略规则文件，定义扫描与分析时需要排除的文件与目录。"
                tags = ["configuration", "ignore-rules"]
            elif path.endswith(".jsonl"):
                summary = f"训练数据文件（JSONL 格式），共 {total_lines} 行。"
                tags = ["training-data", "data"]
            elif path == "scripts/import-skill.ts":
                summary = "技能导入脚本，将 Markdown 格式的技能定义解析并转换为 JSON。"
                tags = ["script", "skill-importer", "utility"]
            elif path.endswith("prompt/deepseek.txt") or path.endswith("prompt/default.txt"):
                summary = f"AI 系统提示词模板文件，定义 Agent 的行为规范与工具使用方式。"
                tags = ["system-prompt", "ai-configuration"]
            elif path == "tests/integration/sub-agent-prompts.md":
                summary = "子 Agent 触发测试的 Prompt 设计文档，提供多种强制触发子 Agent 的对话模板。"
                tags = ["testing", "prompt-design", "multi-agent"]
            
            if not summary:
                func_count = metrics.get("functionCount", 0)
                class_count = metrics.get("classCount", 0)
                export_count = metrics.get("exportCount", 0)
                
                if path in KNOWN_FILES:
                    summary = f"{KNOWN_FILES[path]}，共 {total_lines} 行。"
                elif export_count >= 100:
                    summary = f"大型 barrel 文件，集中导出 {export_count} 个公共 API，整合子模块的全部对外接口。"
                elif export_count >= 30:
                    summary = f"Barrel 出口文件，导出 {export_count} 个符号，涵盖类型定义、函数与类。"
                elif func_count > 0 or class_count > 0:
                    parts = []
                    if func_count:
                        parts.append(f"{func_count} 个函数")
                    if class_count:
                        parts.append(f"{class_count} 个类")
                    summary = f"包含{'、'.join(parts)}的源码文件，共 {total_lines} 行。"
                else:
                    summary = f"源码文件，共 {total_lines} 行。"
            
            if ".test." in path or ".spec." in path or "/test/" in path:
                summary = "测试文件。" + summary
        
        node_id = f"{node_type}:{path}"
        node = {
            "id": node_id,
            "type": node_type,
            "name": name,
            "filePath": path,
            "summary": summary.strip(),
            "tags": tags,
            "complexity": complexity
        }
        nodes.append(node)
        node_ids_set.add(node_id)
        
        # FUNCTION / CLASS nodes for code files
        if file_cat == "code":
            functions = r.get("functions", [])
            classes = r.get("classes", [])
            export_names = [e["name"] for e in r.get("exports", [])]
            
            for func in functions:
                fname = func["name"]
                fstart = func.get("startLine", 0)
                fend = func.get("endLine", 0)
                flines = fend - fstart + 1
                
                # Significance: 10+ lines OR exported
                if flines >= 10 or fname in export_names:
                    func_id = f"function:{path}:{fname}"
                    is_exported = fname in export_names
                    
                    params = func.get("params", [])
                    param_str = "、".join(params[:5])
                    if len(params) > 5:
                        param_str += f" 等 {len(params)} 个参数"
                    func_summary = f"函数{f'（导出）' if is_exported else ''}，第 {fstart}-{fend} 行，参数: {param_str or '无'}。"
                    
                    nodes.append({
                        "id": func_id, "type": "function", "name": fname,
                        "filePath": path, "lineRange": [fstart, fend],
                        "summary": func_summary,
                        "tags": pick_func_tags(fname, is_exported, path),
                        "complexity": "simple" if flines < 30 else "moderate"
                    })
                    node_ids_set.add(func_id)
                    
                    edges.append({"source": node_id, "target": func_id, "type": "contains", "direction": "forward", "weight": 1.0})
                    if is_exported:
                        edges.append({"source": node_id, "target": func_id, "type": "exports", "direction": "forward", "weight": 0.8})
            
            for cls in classes:
                cname = cls["name"]
                cstart = cls.get("startLine", 0)
                cend = cls.get("endLine", 0)
                clines = cend - cstart + 1
                methods = cls.get("methods", [])
                
                if len(methods) >= 2 or clines >= 20 or cname in export_names:
                    cls_id = f"class:{path}:{cname}"
                    is_exported = cname in export_names
                    
                    prop_count = len(cls.get("properties", []))
                    cls_summary = f"类{f'（导出）' if is_exported else ''}，第 {cstart}-{cend} 行，{len(methods)} 个方法"
                    if prop_count:
                        cls_summary += f"，{prop_count} 个属性"
                    cls_summary += "。"
                    
                    nodes.append({
                        "id": cls_id, "type": "class", "name": cname,
                        "filePath": path, "lineRange": [cstart, cend],
                        "summary": cls_summary,
                        "tags": pick_cls_tags(cname, is_exported, path),
                        "complexity": "simple" if clines < 50 else ("moderate" if clines < 150 else "complex")
                    })
                    node_ids_set.add(cls_id)
                    
                    edges.append({"source": node_id, "target": cls_id, "type": "contains", "direction": "forward", "weight": 1.0})
                    if is_exported:
                        edges.append({"source": node_id, "target": cls_id, "type": "exports", "direction": "forward", "weight": 0.8})
        
        # IMPORT EDGES — 1:1 from batchImportData
        file_imports = batch_import_data.get(path, [])
        for imp_path in file_imports:
            if imp_path.endswith(('.md', '.txt')):
                target_type = "document"
            elif imp_path.endswith('.json'):
                target_type = "config"
            else:
                target_type = "file"
            
            target_id = f"{target_type}:{imp_path}"
            edges.append({
                "source": node_id, "target": target_id,
                "type": "imports", "direction": "forward", "weight": 0.7
            })
    
    # TESTED_BY edges: if a test file imports a source file, also emit tested_by
    test_file_edges = []
    for e in edges:
        if e["type"] == "imports":
            src = e["source"]
            tgt = e["target"]
            # Check if source is a test file
            src_path = src.split(":", 1)[1]
            if ".test." in src_path or ".spec." in src_path or "/test/" in src_path:
                test_file_edges.append({
                    "source": tgt,  # production -> test (will be canonicalized later)
                    "target": src,
                    "type": "tested_by",
                    "direction": "forward",
                    "weight": 0.5
                })
    edges.extend(test_file_edges)
    
    # Write
    output = {"nodes": nodes, "edges": edges}
    out_path = f"{OUT}/batch-{batch_idx}.json"
    with open(out_path, "w") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    funcs = sum(1 for n in nodes if n['type'] == 'function')
    classes = sum(1 for n in nodes if n['type'] == 'class')
    imp_edges = sum(1 for e in edges if e['type'] == 'imports')
    test_edges = sum(1 for e in edges if e['type'] == 'tested_by')
    print(f"Batch {batch_idx}: {len(nodes)} nodes ({funcs}f/{classes}c), {len(edges)} edges ({imp_edges}i/{test_edges}t)")

