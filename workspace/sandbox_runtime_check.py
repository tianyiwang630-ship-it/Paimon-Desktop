from pathlib import Path
from agent.tools.read_tool import ReadTool
from agent.tools.write_tool import WriteTool
from agent.tools.bash_tool import BashTool

# Use workspace for temporary validation artifacts
root = Path('workspace/sandbox_check').resolve()
(root / 'input').mkdir(parents=True, exist_ok=True)
(root / 'output').mkdir(parents=True, exist_ok=True)
(root / 'temp').mkdir(parents=True, exist_ok=True)

allowed_file = root / 'output' / 'ok.txt'
blocked_file = Path('D:/forbidden_outside.txt')

w = WriteTool()
w.sandbox_root = str(root)
w.sandbox_read_roots = [str(root)]
w.sandbox_write_roots = [str(root)]

print('write_allowed=', w.execute(file_path=str(allowed_file), content='ok'))
print('write_blocked=', w.execute(file_path=str(blocked_file), content='x'))

r = ReadTool()
r.sandbox_root = str(root)
r.sandbox_read_roots = [str(root)]
r.sandbox_write_roots = [str(root)]
print('read_allowed=', r.execute(file_path=str(allowed_file))[:150])
print('read_blocked=', r.execute(file_path=str(blocked_file))[:150])

b = BashTool(timeout=10)
b.sandbox_root = str(root)
b.sandbox_read_roots = [str(root)]
b.sandbox_write_roots = [str(root)]
b.command_allowlist = {'echo', 'cmd', 'powershell', 'pwsh'}

res_ok = b.execute(command='echo hello')
res_block = b.execute(command='git status')
print('bash_ok=', {k: res_ok.get(k) for k in ('success','returncode','stderr')})
print('bash_block=', res_block)
