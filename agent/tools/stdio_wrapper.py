#!/usr/bin/env python3
"""
STDIO Wrapper -  MCP Server  JSON-RPC 

 MCP server open-websearch stdout
 MCP stdout  JSON-RPC 
 JSON-RPC  stderr

 Windows  CRLF 
"""

import sys
import subprocess
import json
import threading
import os
import shutil


def is_json_rpc(line_bytes):
    """ JSON-RPC """
    try:
        text = line_bytes.decode('utf-8').strip()
        if not text:
            return False
        obj = json.loads(text)
        return isinstance(obj, dict) and (
            'jsonrpc' in obj or 'id' in obj or 'method' in obj or 'result' in obj
        )
    except Exception:
        return False


def filter_stdout(process):
    """ stdout JSON-RPC """
    try:
        while True:
            line = process.stdout.readline()
            if not line:
                break
            if is_json_rpc(line):
                # JSON-RPC    stdout
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            else:
                #    stderr
                try:
                    text = line.decode('utf-8', errors='replace').rstrip('\r\n')
                    if text.strip():
                        sys.stderr.write(f"[MCP Debug] {text}\n")
                        sys.stderr.flush()
                except Exception:
                    pass
    except Exception as e:
        sys.stderr.write(f"[Wrapper] stdout filter error: {e}\n")
        sys.stderr.flush()


def forward_stderr(process):
    """ stderr"""
    try:
        while True:
            line = process.stderr.readline()
            if not line:
                break
            try:
                text = line.decode('utf-8', errors='replace')
                sys.stderr.write(text)
                sys.stderr.flush()
            except Exception:
                pass
    except Exception:
        pass


def forward_stdin(process):
    """ stdin"""
    try:
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                break
            process.stdin.write(line)
            process.stdin.flush()
    except Exception as e:
        sys.stderr.write(f"[Wrapper] stdin forward error: {e}\n")
        sys.stderr.flush()


def resolve_command(args):
    """
     MCP SDK 

     Windows  shutil.which() 
     .cmd / .bat / .exe 
    """
    command = args[0]
    lower_command = command.lower()

    bundled_node = os.environ.get("SKILLS_MCP_NODE", "").strip()
    if lower_command in {"node", "node.exe"} and bundled_node:
        if os.path.exists(bundled_node):
            return [bundled_node] + args[1:]
        sys.stderr.write(f"[Wrapper] SKILLS_MCP_NODE not found: {bundled_node}\n")
        sys.stderr.flush()

    if os.name == 'nt':
        # 
        resolved = shutil.which(command)
        if resolved:
            return [resolved] + args[1:]

        # 
        for ext in ['.cmd', '.bat', '.exe']:
            resolved = shutil.which(command + ext)
            if resolved:
                return [resolved] + args[1:]

    return args


def main():
    """"""
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: stdio_wrapper.py <command> [args...]\n")
        sys.exit(1)

    command = resolve_command(sys.argv[1:])

    sys.stderr.write(f"[Wrapper] Starting: {' '.join(command)}\n")
    sys.stderr.flush()

    # 
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    # 
    threads = [
        threading.Thread(target=filter_stdout, args=(process,), daemon=True),
        threading.Thread(target=forward_stderr, args=(process,), daemon=True),
        threading.Thread(target=forward_stdin, args=(process,), daemon=True),
    ]
    for t in threads:
        t.start()

    # 
    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()
        process.wait()

    sys.exit(process.returncode)


if __name__ == "__main__":
    main()
