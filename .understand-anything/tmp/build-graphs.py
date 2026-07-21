import json, os, sys

project_root = "/Users/Zhuanz/Documents/CS/项目/paw-ts"

# ---- Helper functions ----

TAG_PATTERNS = {
    "entry-point": ["index.ts", "index.js", "__init__.py", "manage.py", "main.go", "main.rs", "lib.rs",
                    "Application.java", "Main.java", "Program.cs", "config.ru", "mod.rs"],
    "test": [".test.", ".spec.", "test_", "_test.go", "Test.java", "_spec.rb", "Test.php", "Tests.cs"],
    "barrel": ["index.ts", "index.js", "__init__.py", "mod.rs"],
}

def is_barrel(results):
    """Detect barrel/module files that primarily re-export"""
    funcs = results.get('functions', [])
    classes = results.get('classes', [])
    exports = results.get('exports', [])
    # Many exports but few functions/classes = barrel
    return len(exports) > 3 and len(funcs) + len(classes) < 2

def is_test(path):
    fname = os.path.basename(path).lower()
    for p in TAG_PATTERNS["test"]:
        if p in fname:
            return True
    return "test/" in path or "tests/" in path or "benchmarks/" in path

def assign_tags(path, results, file_category):
    tags = []
    basename = os.path.basename(path).lower()
    funcs = results.get('functions', [])
    classes = results.get('classes', [])
    exports = results.get('exports', [])

    # Test files
    if is_test(path):
        tags.append("test")
    
    # Barrel files
    if is_barrel(results) and not is_test(path):
        tags.append("barrel")
        tags.append("entry-point")
    
    # Entry point detection
    if basename in ["index.ts", "index.js"] and len(exports) > 3:
        if "entry-point" not in tags:
            tags.append("entry-point")

    # Benchmarks
    if "benchmark" in path or "benchmarks" in path:
        tags.append("benchmark")
    
    # API handlers (class name pattern)
    for c in classes:
        cname = c.get('name', '')
        if 'Handler' in cname or 'Controller' in cname:
            tags.append("api-handler")
    
    # Type definitions
    if len(funcs) == 0 and len(classes) == 0 and len(exports) > 0:
        has_types = any('interface' in str(e) or 'type' in str(e) or 'Type' in str(e) for e in exports)
        if has_types:
            tags.append("type-definition")
    
    # Fixtures
    if basename == "fixtures.ts" or "fixture" in basename:
        tags.append("test-fixture")
    
    # Category-specific tags  
    if is_test(path) and "e2e" in path:
        tags.append("integration-test")
    elif is_test(path) and "integration" in path:
        tags.append("integration-test")
    elif is_test(path):
        tags.append("unit-test")

    # Source file tags
    if not is_test(path) and "benchmarks" not in path:
        dir_parts = path.split('/')
        # Memory module
        if 'memory' in path:
            if 'retriev' in basename or 'retriev' in path:
                tags.append("retrieval")
            if 'embedding' in basename:
                tags.append("embeddings")
            if 'scorer' in basename:
                tags.append("scoring")
            if 'tokenizer' in basename:
                tags.append("tokenization")
            tags.append("memory")
        # Agent module
        if 'agent' in path:
            if 'orchestrator' in basename:
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
            tags.append("agent")
        # Eval module
        if 'eval' in path:
            if 'scorer' in path:
                tags.append("scoring")
            if 'test-suite' in path or 'builtin' in path:
                tags.append("test-suite")
            if 'cli' in path:
                tags.append("cli")
            tags.append("evaluation")
        # Core module
        if 'core' in path:
            if 'context' in path:
                if 'compactor' in basename:
                    tags.append("compression")
                if 'manager' in basename:
                    tags.append("context-management")
                if 'policy' in basename:
                    tags.append("policy")
                if 'pruner' in basename:
                    tags.append("pruning")
                tags.append("context")
            if 'token' in basename:
                tags.append("tokenization")
            if 'todo' in basename:
                tags.append("task-management")
            if 'sanitiz' in basename:
                tags.append("security")
            if 'tool-result' in path:
                tags.append("tool-results")
            if 'app-state' in basename:
                tags.append("state-management")
            tags.append("core")
        # Workspace module
        if 'workspace' in path:
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
            tags.append("workspace")
        # Benchmarks
        if 'benchmark' in path or 'longbench' in path:
            tags.append("benchmark")
    
    # Fill to at least 3 tags
    if len(tags) < 3:
        if is_test(path):
            if "test" not in tags:
                tags.append("test")
        else:
            # Determine module
            if 'memory' in path:
                tags.append("memory")
            elif 'agent' in path:
                tags.append("agent")
            elif 'eval' in path:
                tags.append("evaluation")
            elif 'core' in path:
                tags.append("core")
            elif 'workspace' in path:
                tags.append("workspace")
            else:
                tags.append("utilities")
    
    # Deduplicate and limit to 5
    seen = set()
    unique = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            unique.append(t)
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
    
    if 'test' in basename.lower() or 'test/' in path:
        return f"测试用例：{name}({params})，{size} 行。"
    
    if 'export' in name or 'index' in name:
        return f"模块导出入口，{size} 行。"
    
    # Build contextual summary
    context = ""
    if 'format' in name.lower():
        context = "格式化相关"
    elif 'parse' in name.lower():
        context = "解析相关"
    elif 'create' in name.lower() or 'build' in name.lower():
        context = "工厂/构建"
    elif 'get' in name.lower() or 'fetch' in name.lower() or 'retrieve' in name.lower():
        context = "数据获取"
    elif 'set' in name.lower():
        context = "数据设置"
    elif 'resolve' in name.lower():
        context = "配置解析"
    elif 'run' in name.lower() or 'execute' in name.lower():
        context = "执行入口"
    elif 'compute' in name.lower() or 'calculate' in name.lower() or 'score' in name.lower():
        context = "计算/评分"
    elif 'save' in name.lower() or 'store' in name.lower() or 'persist' in name.lower():
        context = "持久化"
    elif 'load' in name.lower():
        context = "数据加载"
    elif 'init' in name.lower():
        context = "初始化"
    elif 'validate' in name.lower() or 'check' in name.lower() or 'guard' in name.lower():
        context = "验证/检查"
    elif 'sanitize' in name.lower():
        context = "安全清洗"
    elif 'tokeni' in name.lower():
        context = "分词"
    elif 'embed' in name.lower():
        context = "向量嵌入"
    elif 'extract' in name.lower():
        context = "信息提取"
    elif 'reflect' in name.lower():
        context = "反思/自省"
    elif 'summar' in name.lower() or 'compact' in name.lower():
        context = "摘要/压缩"
    elif 'select' in name.lower() or 'filter' in name.lower():
        context = "选择/过滤"
    elif 'archive' in name.lower():
        context = "归档"
    elif 'retrieve' in name.lower():
        context = "检索"
    
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
    
    if 'test' in path.lower():
        return f"测试类 {name}，{len(methods)} 个测试方法，{size} 行。"
    return f"类 {name}，{len(methods)} 个方法、{len(properties)} 个属性，{size} 行。"

def file_summary(path, results, file_category):
    basename = os.path.basename(path)
    funcs = len(results.get('functions', []))
    classes = len(results.get('classes', []))
    exports = len(results.get('exports', []))
    lines = results.get('nonEmptyLines', 0)
    
    if is_test(path):
        if "e2e" in path:
            return f"端到端测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
        elif "benchmark" in path or "benchmarks" in path:
            return f"基准测试文件，{funcs} 个测试案例，{lines} 行有效代码。"
        elif "integration" in path:
            return f"集成测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
        elif "fixtures" in basename:
            return f"测试夹具文件，提供共享测试数据和工具函数。"
        else:
            return f"单元测试文件，{funcs} 个测试函数，{lines} 行有效代码。"
    
    if is_barrel(results):
        return f"模块入口 barrel 文件，重新导出 {exports} 个公共符号。"
    
    # Source files
    if 'memory' in path:
        prefix = "memory 包中"
        if 'auto-memory' in basename:
            return f"自动记忆提取与管理，{funcs} 个函数，{classes} 个类，{lines} 行。"
        if 'embedding' in basename:
            return f"嵌入向量缓存管理，{funcs} 个函数，{classes} 个类，{lines} 行。"
        if 'archive' in basename:
            return f"记忆归档功能，{funcs} 个函数，{lines} 行。"
        if 'profile' in basename:
            return f"记忆画像/摘要配置，{lines} 行。"
        if 'query' in basename and 'memory-query' in basename:
            return f"记忆查询构建器，{funcs} 个函数，{lines} 行。"
        if 'record' in basename and 'memory-record' in basename:
            return f"记忆记录核心类型定义和工厂函数，{exports} 个导出，{lines} 行。"
        if 'reflect' in basename:
            return f"记忆反思引擎，{funcs} 个函数，{lines} 行。"
        if 'retrieval-cascade' in basename:
            return f"级联记忆检索策略，{funcs} 个函数，{lines} 行。"
        if 'retrieve' in basename and 'memory-retrieve' in basename:
            return f"记忆检索统一入口，协调多种检索方式，{lines} 行。"
        if 'retriever' in basename and 'memory-retriever' in basename:
            return f"记忆检索器类，封装检索流程，{classes} 个类，{lines} 行。"
        if 'scorer' in basename:
            return f"记忆评分引擎，BM25 和语义评分，{lines} 行。"
        if 'selector' in basename:
            return f"记忆选择策略，支持不同选择算法，{lines} 行。"
        if 'tokenizer' in basename:
            return f"记忆分词器，{funcs} 个函数，{lines} 行。"
        if 'session-memory' in basename:
            return f"会话记忆管理类，{classes} 个类，{lines} 行。"
        if 'unified-memory' in basename:
            return f"统一记忆存储抽象，{classes} 个类，{lines} 行。"
    
    if 'agent' in path:
        if 'auxiliary-complete' in basename:
            return f"辅助 LLM 补全工具函数，{lines} 行。"
        if 'child-system-prompt' in basename:
            return f"子 Agent 系统提示词构建，{lines} 行。"
        if 'compression-agent' in basename:
            return f"压缩 Agent，对上下文进行压缩，{lines} 行。"
        if 'format-conversation' in basename:
            return f"对话格式化工具，为记忆提取准备数据，{lines} 行。"
        if 'llm-memory-selector' in basename:
            return f"LLM 驱动记忆选择器，{lines} 行。"
        if 'memory-extraction-agent' in basename:
            return f"记忆提取 Agent，扫描敏感信息并提取记忆，{lines} 行。"
        if 'orchestrator-factory' in basename:
            return f"Orchestrator 工厂函数，{lines} 行。"
        if 'orchestrator.ts' == basename:
            return f"核心 Agent Orchestrator，主运行循环，{lines} 行。"
        if 'action-handlers' in basename:
            return f"Orchestrator 操作处理器，处理 Agent 动作，{lines} 行。"
        if 'agent-args' in basename:
            return f"Agent 参数构建工具，{lines} 行。"
        if 'agent-group' in basename:
            return f"Agent 群组管理，{lines} 行。"
        if 'constants' in basename:
            return f"Orchestrator 常量定义，{lines} 行。"
        if 'context-summarizer' in basename:
            return f"上下文摘要器，{lines} 行。"
        if 'memory-extraction.ts' in basename:
            return f"Orchestrator 记忆提取逻辑，{lines} 行。"
        if 'session-summarizer' in basename:
            return f"会话摘要器，{lines} 行。"
        if 'tool-runner' in basename:
            return f"工具执行器，{lines} 行。"
        if 'types.ts' == basename:
            return f"Orchestrator 类型定义，{lines} 行。"
        if 'parse-agent-action' in basename:
            return f"Agent 动作解析器，{lines} 行。"
        if 'circuit-breaker' in basename:
            return f"熔断器实现，{lines} 行。"
        if 'resolve-max-steps' in basename:
            return f"最大步数解析，{lines} 行。"
        if 'resolve-memory-retrieval' in basename:
            return f"记忆检索配置解析，{lines} 行。"
        if 'resolve-plan-snapshot' in basename:
            return f"计划快照最大项数解析，{lines} 行。"
        if 'resolve-shell-sandbox' in basename:
            return f"Shell 沙箱配置解析，{lines} 行。"
        if 'session.ts' == basename:
            return f"会话管理，{lines} 行。"
        if 'settings.ts' == basename:
            return f"Agent 配置设置，{lines} 行。"
        if 'stub-run' in basename:
            return f"桩运行模式，{lines} 行。"
        if 'sub-agent-launcher' in basename:
            return f"子 Agent 启动器，{lines} 行。"
        if 'tool-result-detail' in basename:
            return f"工具结果详情格式化，{lines} 行。"
    
    if 'eval' in path:
        if 'eval-command' in basename:
            return f"Eval CLI 命令入口，{lines} 行。"
        if 'data-collector' in basename:
            return f"评测数据收集器，{lines} 行。"
        if 'eval-record' in basename:
            return f"评测记录类型定义，{lines} 行。"
        if 'eval-settings' in basename:
            return f"评测配置设置，{lines} 行。"
        if 'runner.ts' == basename:
            return f"评测运行器核心逻辑，{lines} 行。"
        if 'aggregator' in basename:
            return f"评分聚合器，{lines} 行。"
        if 'llm-scorer' in basename:
            return f"LLM 评分器，{lines} 行。"
        if 'reporter' in basename:
            return f"评测报告生成器，{lines} 行。"
        if 'rule-scorer' in basename:
            return f"规则评分器，{lines} 行。"
        if 'types.ts' == basename and 'scorer' in path:
            return f"评分器类型定义，{lines} 行。"
        if 'test-suite' in path:
            name = basename.replace('.ts', '')
            if 'index' in name:
                return f"内置测试套件 barrel 入口，重新导出所有套件。"
            if 'adversarial' in name:
                return f"对抗性测试套件，{lines} 行。"
            if 'code-gen' in name:
                return f"代码生成测试套件，{lines} 行。"
            if 'context-mgmt' in name:
                return f"上下文管理测试套件，{lines} 行。"
            if 'core-tools' in name:
                return f"核心工具测试套件，{lines} 行。"
            if 'high-frequency' in name:
                return f"高频场景测试套件，{lines} 行。"
            if 'memory-retrieval' in name:
                return f"记忆检索测试套件，{lines} 行。"
            if 'multi-step' in name:
                return f"多步骤测试套件，{lines} 行。"
            if 'shell-safety' in name:
                return f"Shell 安全测试套件，{lines} 行。"
        if 'loader' in basename:
            return f"测试套件加载器，{lines} 行。"
        if 'types.ts' == basename and 'test-suite' in path:
            return f"测试套件类型定义，{lines} 行。"
        if 'training-data' in basename:
            return f"训练数据导出器，{lines} 行。"
    
    if 'core' in path:
        if 'app-state' in basename:
            return f"应用状态管理，{lines} 行。"
        if 'compactor' in basename:
            return f"上下文压缩器，{lines} 行。"
        if 'manager' in basename:
            return f"上下文管理器，{lines} 行。"
        if 'policy' in basename:
            return f"上下文策略管理，{lines} 行。"
        if 'pruner' in basename:
            return f"上下文修剪器，{lines} 行。"
        if 'eval-hooks' in basename:
            return f"Eval 钩子集成，{lines} 行。"
        if 'input-sanitizer' in basename:
            return f"输入安全清洗器，{lines} 行。"
        if 'todo' in basename:
            return f"Todo 任务管理，{lines} 行。"
        if 'token-estimate' in basename:
            return f"Token 估算工具，{lines} 行。"
        if 'token-estimator' in basename:
            return f"Token 估算器核心逻辑，{lines} 行。"
        if 'format' in basename and 'tool-result' in path:
            return f"工具结果格式化，{lines} 行。"
        if 'storage' in basename and 'tool-result' in path:
            return f"工具结果存储，{lines} 行。"
    
    if 'workspace' in path:
        if 'read' in basename and 'files' in path:
            return f"文件读取工具，{lines} 行。"
        if 'write' in basename and 'files' in path:
            return f"文件写入工具，{lines} 行。"
        if 'git-tools' in basename:
            return f"Git 操作工具集，{lines} 行。"
        if 'mention-resolver' in basename:
            return f"提及解析器，{lines} 行。"
        if 'notebook-tools' in basename:
            return f"Notebook 操作工具，{lines} 行。"
        if 'patch-tools' in basename:
            return f"Patch 操作工具，{lines} 行。"
        if 'path-guard' in basename:
            return f"路径安全守卫，{lines} 行。"
        if 'project-context' in basename:
            return f"项目上下文自动分析，{lines} 行。"
    
    if 'benchmarks' in path or 'longbench' in path:
        if 'adapter' in basename:
            return f"LongBench 适配器，{lines} 行。"
        if 'benchmark' in basename:
            return f"LongBench 基准测试，{lines} 行。"
    
    return f"TypeScript 源文件，{funcs} 个函数，{classes} 个类，{lines} 行。"

def function_tags(fn, path):
    tags = []
    name = fn.get('name', '')
    if any(k in name.lower() for k in ['test', 'it ', 'describe']):
        tags.append("test")
    if 'format' in name.lower():
        tags.append("formatting")
    if 'parse' in name.lower():
        tags.append("parsing")
    if 'retrieve' in name.lower():
        tags.append("retrieval")
    if 'embed' in name.lower():
        tags.append("embeddings")
    if 'score' in name.lower():
        tags.append("scoring")
    if 'token' in name.lower():
        tags.append("tokenization")
    if 'summar' in name.lower() or 'compact' in name.lower():
        tags.append("summarization")
    if 'extract' in name.lower():
        tags.append("extraction")
    if len(tags) < 3:
        if is_test(path):
            tags.append("test")
    return tags[:4]

def class_tags(cls, path):
    tags = []
    name = cls.get('name', '')
    if 'test' in name.lower():
        tags.append("test")
    if 'handler' in name.lower():
        tags.append("api-handler")
    if 'store' in name.lower() or 'manager' in name.lower():
        tags.append("state-management")
    if len(tags) < 2:
        if is_test(path):
            tags.append("test")
    return tags[:4]

def should_emit_function(fn, path, exports):
    """Significance filter for functions"""
    name = fn.get('name', '')
    start = fn.get('startLine', 0)
    end = fn.get('endLine', 0)
    size = end - start if isinstance(start, int) and isinstance(end, int) else 0
    
    # Reject trivial one-liners
    if size < 10:
        return False
    # Always emit if exported
    for e in exports:
        if e.get('name') == name:
            return True
    # Emit if 15+ lines
    return size >= 15

def should_emit_class(cls, path, exports):
    """Significance filter for classes"""
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
    
    # Read extraction results
    extract_path = f"{project_root}/.understand-anything/tmp/ua-file-extract-results-{batch_idx}.json"
    with open(extract_path) as f:
        extract = json.load(f)
    
    # Read batch data
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
        
        # File node
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
        for e in exports:
            ename = e.get('name', '')
            # Check if we have a function or class node for this export
            func_names = [f['name'] for f in funcs if should_emit_function(f, path, exports)]
            class_names = [c['name'] for c in classes if should_emit_class(c, path, exports)]
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
            imp_type = type_map.get('code', 'file')
            edges.append({
                "source": f"{node_type}:{path}",
                "target": f"file:{imp_path}",
                "type": "imports",
                "direction": "forward",
                "weight": 0.7
            })
        
        # Test edges (tested_by)
        if is_test(path):
            for imp_path in imports_list:
                if not is_test(imp_path) and 'fixture' not in imp_path.lower() and imp_path.startswith('packages/'):
                    if imp_path.endswith('.ts') and 'test' not in imp_path:
                        # Production file tested by this test file
                        edges.append({
                            "source": f"file:{imp_path}",
                            "target": f"{node_type}:{path}",
                            "type": "tested_by",
                            "direction": "forward",
                            "weight": 0.5
                        })
        
        # Call graph edges (from extraction script)
        call_graph = r.get('callGraph', [])
        for cg in call_graph:
            caller = cg.get('caller', '')
            callee = cg.get('callee', '')
            # Only emit if we have nodes for both
            caller_func_names = [f['name'] for f in funcs if should_emit_function(f, path, exports)]
            callee_func_names = [f['name'] for f in funcs if should_emit_function(f, path, exports)]
            if caller in caller_func_names and callee in callee_func_names:
                edges.append({
                    "source": f"function:{path}:{caller}",
                    "target": f"function:{path}:{callee}",
                    "type": "calls",
                    "direction": "forward",
                    "weight": 0.8
                })
    
    print(f"  Nodes: {len(nodes)}, Edges: {len(edges)}", file=sys.stderr)
    
    # Check if we need to split
    out_dir = f"{project_root}/.understand-anything/intermediate"
    os.makedirs(out_dir, exist_ok=True)
    
    if len(nodes) <= 60 and len(edges) <= 120:
        out_path = f"{out_dir}/batch-{batch_idx}.json"
        with open(out_path, 'w') as f:
            json.dump({"nodes": nodes, "edges": edges}, f, indent=2, ensure_ascii=False)
        print(f"  Written to {out_path}", file=sys.stderr)
        return 1, len(nodes), len(edges)
    else:
        # Split by files
        file_paths = sorted(set(n.get('filePath', '') for n in nodes if n.get('filePath')))
        num_parts = max(2, (max(len(nodes) // 60, len(edges) // 120) + 1))
        chunk_size = max(1, len(file_paths) // num_parts)
        
        parts_written = 0
        for k in range(num_parts):
            start_idx = k * chunk_size
            end_idx = len(file_paths) if k == num_parts - 1 else (k + 1) * chunk_size
            chunk_files = set(file_paths[start_idx:end_idx])
            
            part_nodes = [n for n in nodes if not n.get('filePath') or n['filePath'] in chunk_files]
            node_ids = set(n['id'] for n in part_nodes)
            # Edges where source is in this part
            part_edges = [e for e in edges if e['source'] in node_ids]
            
            out_path = f"{out_dir}/batch-{batch_idx}-part-{k+1}.json"
            with open(out_path, 'w') as f:
                json.dump({"nodes": part_nodes, "edges": part_edges}, f, indent=2, ensure_ascii=False)
            parts_written += 1
            print(f"  Part {k+1}: {len(part_nodes)} nodes, {len(part_edges)} edges -> {out_path}", file=sys.stderr)
        
        return parts_written, len(nodes), len(edges)

# Process all batches
total_parts = 0
for i in range(1, 7):
    p, n, e = process_batch(i)
    total_parts += p
    print(f"  Done batch {i}: {p} part(s), {n} nodes, {e} edges", file=sys.stderr)

print(f"\nTotal: {total_parts} output files", file=sys.stderr)
