"""Compact live status without prompts, credentials or private reasoning."""
import json
import pathlib
import sys
import time

for arg in sys.argv[1:]:
    root = pathlib.Path(arg)
    def read(name, default=None):
        p = root / name
        return json.loads(p.read_text(encoding='utf-8')) if p.exists() else default
    def rows(name):
        p = root / name
        result = []
        if p.exists():
            for line in p.read_text(encoding='utf-8').splitlines():
                try: result.append(json.loads(line))
                except json.JSONDecodeError: pass
        return result
    p = read('protocol.json', {})
    result = read('result.json', {})
    wire = rows('wire.jsonl')
    phase_starts = {row.get('callId'): row for row in rows('phases.jsonl') if row.get('type') == 'start'}
    events = rows('events.jsonl')
    tools = []
    for row in events:
        e = row.get('event', {})
        if e.get('type') in ['tool.call', 'tool.result']:
            tools.append({k:e[k] for k in ['type','tool','ok'] if k in e})
        if e.get('type') == 'assistant':
            content = e.get('message', {}).get('content', [])
            for b in content if isinstance(content, list) else []:
                if b.get('type') == 'tool_use': tools.append({'tool':b.get('name')})
        if e.get('type') in ['tool-start','tool-end','tool_start','tool_end']:
            tools.append({k:e[k] for k in ['type','name','toolName'] if k in e})
    workspace = pathlib.Path(p.get('workspaceRoot', '/nonexistent'))
    current = {}
    phase = None
    requests = [r for r in wire if r.get('type')=='request' and r.get('route','/v1/messages')=='/v1/messages']
    if requests:
        request = requests[-1]
        start = phase_starts.get(request.get('callId'), {})
        phase = start.get('phase')
        if phase == 'agent_loop':
            phase += ':child' if start.get('runId', '').startswith('child-run-') else ':root'
        response = root/'relay'/f"{request['id']}.body" if (root/'relay').exists() else root/f"response-{request['id']}.sse"
        thinking=text=arguments=0
        if response.exists():
            for line in response.read_text(encoding='utf-8',errors='replace').splitlines():
                if not line.startswith('data:'):continue
                try:e=json.loads(line[5:])
                except ValueError:continue
                d=e.get('delta',{})
                if d.get('type')=='thinking_delta':thinking+=len(d.get('thinking',''))
                if d.get('type')=='text_delta':text+=len(d.get('text',''))
                if d.get('type')=='input_json_delta':arguments+=len(d.get('partial_json',''))
                for c in e.get('choices',[]):
                    d=c.get('delta',{});thinking+=len(d.get('reasoning_content') or '');text+=len(d.get('content') or '')
                    for call in d.get('tool_calls',[]):arguments+=len(call.get('function',{}).get('arguments') or '')
        current={'thinkingCharacters':thinking,'textCharacters':text,'toolArgumentCharacters':arguments}
    files = [str(f.relative_to(workspace)).replace('\\','/') for f in workspace.rglob('*') if f.is_file() and not any(x.startswith('.') for x in f.relative_to(workspace).parts)] if workspace.exists() else []
    ended_at = result.get('finishedAt', time.time()*1000)
    print(json.dumps({'run':root.name,'elapsedSeconds':round((ended_at-p.get('startedAt',ended_at))/1000,1),'settled':(root/'result.json').exists(),'requests':len(requests),'currentPhase':phase,'currentResponse':current,'recentTools':tools[-5:],'files':files[:30],'lastWire':wire[-1].get('type') if wire else None},ensure_ascii=False))
