import json, os, sys

TMP = "/Users/Zhuanz/Documents/CS/项目/paw-ts/.understand-anything/tmp"
OUT = "/Users/Zhuanz/Documents/CS/项目/paw-ts/.understand-anything/intermediate"

os.makedirs(OUT, exist_ok=True)

BATCHES = [25, 26, 27, 28, 29, 30, 31]

for batch_idx in BATCHES:
    # Read batch input (for batchImportData and file metadata)
    with open(f"{TMP}/batches/{batch_idx}.json") as f:
        batch_input = json.load(f)
    
    # Read extraction results
    with open(f"{TMP}/ua-file-extract-results-{batch_idx}.json") as f:
        extraction = json.load(f)
    
    batch_import_data = batch_input.get("batchImportData", {})
    neighbor_map = batch_input.get("neighborMap", {})
    results = extraction.get("results", [])
    
    nodes = []
    edges = []
    
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
            if lang in ("graphql",):
                node_type = "schema"
            elif lang == "sql":
                node_type = "table"
            else:
                node_type = "schema"
        else:
            node_type = "file"
        
        # Determine complexity
        if non_empty < 50:
            complexity = "simple"
        elif non_empty < 200:
            complexity = "moderate"
        else:
            complexity = "complex"
        
        # Determine name
        name = os.path.basename(path) or path
        
        # Generate summary based on file content and category
        summary = ""
        tags = []
        
        if file_cat == "docs":
            if sections:
                first_heading = sections[0].get("heading", "")
                section_count = len(sections)
                summary = f"包含 {section_count} 个章节的文档，主题为「{first_heading}」。"
            else:
                summary = f"文档文件，共 {total_lines} 行。"
            tags = ["documentation"]
            if "README" in path:
                tags.append("entry-point")
            if "plan" in path.lower() or "计划" in path or "方案" in path:
                tags.append("planning")
            if "分析" in path or "analysis" in path.lower():
                tags.append("analysis")
            if "架构" in path or "architecture" in path.lower():
                tags.append("architecture")
            if "升级" in path or "upgrade" in path.lower():
                tags.append("upgrade")
            if "微调" in path or "训练" in path:
                tags.append("fine-tuning")
            if "记忆" in path or "memory" in path.lower():
                tags.append("memory")
            if "测试" in path or "test" in path.lower():
                tags.append("testing")
            if "面试" in path:
                tags.append("interview-prep")
            if "压缩" in path or "compression" in path.lower():
                tags.append("context-compression")
            if "ADR" in path or "决策" in path:
                tags.append("adr")
            if "benchmark" in path.lower() or "eval" in path.lower():
                tags.append("evaluation")
                
        elif file_cat == "config":
            if "package.json" in path:
                pkg_name = name
                summary = f"包配置文件，定义 {pkg_name.split('.')[0]} 包的依赖与导出。"
                tags = ["configuration", "package-manager"]
            elif "tsconfig" in path:
                summary = "TypeScript 编译器配置，继承基础 tsconfig 并指定包含路径。"
                tags = ["configuration", "typescript", "build-system"]
            else:
                summary = f"配置文件，共 {total_lines} 行。"
                tags = ["configuration"]
                
        else:  # code files
            func_count = metrics.get("functionCount", 0)
            class_count = metrics.get("classCount", 0)
            export_count = metrics.get("exportCount", 0)
            import_count = metrics.get("importCount", 0)
            
            if export_count > 50:
                summary = f"核心 barrel 文件，集中导出 {export_count} 个符号，整合所有子模块的公共 API。"
                tags = ["barrel", "entry-point", "exports"]
            elif export_count > 10:
                summary = f"模块入口文件，导出 {export_count} 个公共 API，涵盖 {func_count} 个函数和 {class_count} 个类。"
                tags = ["exports", "entry-point"]
            elif func_count > 0:
                summary = f"包含 {func_count} 个函数{f'和 {class_count} 个类' if class_count > 0 else ''}的源码文件，共 {total_lines} 行。"
                tags = []
            else:
                summary = f"源码文件，共 {total_lines} 行。"
                tags = []
            
            # Detect test files
            if ".test." in path or ".spec." in path or "/test/" in path:
                summary = "测试文件，" + summary
                tags = ["test"] + tags
            
            # Detect specific patterns
            if "cli" in path.lower() and "main" in path:
                tags = ["entry-point", "cli"] + tags
            if "jsx-runtime" in path:
                tags = ["jsx", "runtime"] + tags
            if "cost-tracker" in path:
                tags = ["cost-tracking", "utility"] + tags
            if "errors" in path:
                tags = ["error-handling", "utility"] + tags
            if "find-root" in path:
                tags = ["utility", "path-resolution"] + tags
            if "lsp" in path:
                tags = ["lsp", "language-server"] + tags
            if "network" in path:
                tags = ["network", "web"] + tags
            if "symbol" in path:
                tags = ["symbol-search", "ast"] + tags
            if "watch" in path:
                tags = ["file-watcher", "utility"] + tags
            if "worktree" in path:
                tags = ["git", "worktree"] + tags
            if "paw-md" in path:
                tags = ["markdown", "utility"] + tags
            if "root" in path and path.endswith(".ts"):
                tags = ["utility", "cli"] + tags
            
            # Python-specific
            if lang == "python":
                if "download" in path:
                    tags = ["data-download", "utility"] + tags
                if "generate" in path or "training" in path:
                    tags = ["training-data", "generation"] + tags
                if "run" in path:
                    tags = ["benchmark", "runner"] + tags
        
        # Trim tags
        tags = tags[:5] if len(tags) > 5 else tags
        if not tags:
            tags = ["source-code"]
        
        # Build node ID based on type
        node_id = f"{node_type}:{path}"
        
        node = {
            "id": node_id,
            "type": node_type,
            "name": name,
            "filePath": path,
            "summary": summary.strip() or f"{file_cat} 文件: {path}",
            "tags": tags,
            "complexity": complexity
        }
        nodes.append(node)
        
        # Create function and class nodes for code files
        if file_cat == "code":
            functions = r.get("functions", [])
            classes = r.get("classes", [])
            exports = [e["name"] for e in r.get("exports", [])]
            
            for func in functions:
                fname = func["name"]
                fstart = func.get("startLine", 0)
                fend = func.get("endLine", 0)
                flines = fend - fstart + 1
                
                # Significance filter: 10+ lines OR exported
                if flines >= 10 or fname in exports or len(functions) <= 3:
                    func_id = f"function:{path}:{fname}"
                    func_summary = f"函数，定义于第 {fstart}-{fend} 行，共 {flines} 行。"
                    func_tags = ["function"]
                    if fname in exports:
                        func_tags.append("exported")
                    if fname == "main":
                        func_tags.append("entry-point")
                    
                    nodes.append({
                        "id": func_id,
                        "type": "function",
                        "name": fname,
                        "filePath": path,
                        "lineRange": [fstart, fend],
                        "summary": func_summary,
                        "tags": func_tags,
                        "complexity": "simple" if flines < 30 else "moderate"
                    })
                    
                    # contains edge
                    edges.append({
                        "source": node_id,
                        "target": func_id,
                        "type": "contains",
                        "direction": "forward",
                        "weight": 1.0
                    })
                    
                    # exports edge if exported
                    if fname in exports:
                        edges.append({
                            "source": node_id,
                            "target": func_id,
                            "type": "exports",
                            "direction": "forward",
                            "weight": 0.8
                        })
            
            for cls in classes:
                cname = cls["name"]
                cstart = cls.get("startLine", 0)
                cend = cls.get("endLine", 0)
                clines = cend - cstart + 1
                methods = cls.get("methods", [])
                
                # Significance: 2+ methods OR 20+ lines OR exported
                if len(methods) >= 2 or clines >= 20 or cname in exports:
                    cls_id = f"class:{path}:{cname}"
                    cls_summary = f"类，定义于第 {cstart}-{cend} 行，包含 {len(methods)} 个方法，共 {clines} 行。"
                    cls_tags = ["class"]
                    if cname in exports:
                        cls_tags.append("exported")
                    
                    nodes.append({
                        "id": cls_id,
                        "type": "class",
                        "name": cname,
                        "filePath": path,
                        "lineRange": [cstart, cend],
                        "summary": cls_summary,
                        "tags": cls_tags,
                        "complexity": "simple" if clines < 50 else ("moderate" if clines < 150 else "complex")
                    })
                    
                    # contains edge
                    edges.append({
                        "source": node_id,
                        "target": cls_id,
                        "type": "contains",
                        "direction": "forward",
                        "weight": 1.0
                    })
                    
                    # exports edge
                    if cname in exports:
                        edges.append({
                            "source": node_id,
                            "target": cls_id,
                            "type": "exports",
                            "direction": "forward",
                            "weight": 0.8
                        })
        
        # Import edges
        file_imports = batch_import_data.get(path, [])
        for imp_path in file_imports:
            # Determine target node type based on file extension
            if imp_path.endswith(('.md', '.txt')):
                target_type = "document"
            elif imp_path.endswith('.json'):
                target_type = "config"
            else:
                target_type = "file"
            
            edges.append({
                "source": node_id,
                "target": f"{target_type}:{imp_path}",
                "type": "imports",
                "direction": "forward",
                "weight": 0.7
            })
    
    # Write output
    output = {"nodes": nodes, "edges": edges}
    out_path = f"{OUT}/batch-{batch_idx}.json"
    with open(out_path, "w") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"Batch {batch_idx}: {len(nodes)} nodes, {len(edges)} edges -> {out_path}")
    print(f"  Files: {len(results)}, Functions: {sum(1 for n in nodes if n['type'] == 'function')}, Classes: {sum(1 for n in nodes if n['type'] == 'class')}")

