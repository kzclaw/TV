#!/usr/bin/env python3
"""把工作区改动推到 GitHub（走 api.github.com 的 git database API）。

为什么不直接 git push：沙箱里 github.com 的 TLS 间歇性失败，
api.github.com 稳定。也不整仓推：只推「与基线有差异的文件」，
避免把沙箱里的临时文件带上去。

用法：python3 tools/push_gh.py <repo> <base_dir> <work_dir>
"""
import base64
import hashlib
import json
import os
import sys
import urllib.request
import urllib.parse

REPO = sys.argv[1] if len(sys.argv) > 1 else 'kzclaw/TV'
BASE = sys.argv[2] if len(sys.argv) > 2 else '/tmp/TV_base'
WORK = sys.argv[3] if len(sys.argv) > 3 else '/workspace/TV'
MESSAGE = sys.argv[4] if len(sys.argv) > 4 else 'feat(auth): 密码兜底改成服务端会话 + 修密码框静默失效'
TOKEN = os.environ['GH_TOKEN']
API = f'https://api.github.com/repos/{REPO}'
SKIP_DIRS = {'.git', 'node_modules'}
SKIP_SUFFIX = ('.pem', '.log')


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header('Authorization', f'Bearer {TOKEN}')
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('X-GitHub-Api-Version', '2022-11-28')
    if data:
        req.add_header('Content-Type', 'application/json')
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode() or '{}')
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:400]
            if e.code in (502, 503, 504) and attempt < 4:
                continue
            raise SystemExit(f'{method} {path} 失败 {e.code}: {detail}')
        except Exception:
            if attempt < 4:
                continue
            raise


def rel_files(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(SKIP_SUFFIX):
                continue
            full = os.path.join(dirpath, fn)
            out[os.path.relpath(full, root)] = full
    return out


base_files = rel_files(BASE)
work_files = rel_files(WORK)

changed = [p for p in work_files if p not in base_files or
           hashlib.sha1(open(base_files[p], 'rb').read()).digest() !=
           hashlib.sha1(open(work_files[p], 'rb').read()).digest()]
deleted = [p for p in base_files if p not in work_files]

print(f'改动 {len(changed)} 个文件，删除 {len(deleted)} 个文件')
for p in sorted(changed):
    print('  M/A', p)
for p in sorted(deleted):
    print('  D   ', p)

ref = api('GET', '/git/ref/heads/main')
head = ref['object']['sha']
commit = api('GET', f'/git/commits/{head}')
base_tree = commit['tree']['sha']
print(f'远端 HEAD = {head}  base_tree = {base_tree}')

tree_entries = []
for p in sorted(changed):
    raw = open(work_files[p], 'rb').read()
    blob = api('POST', '/git/blobs', {
        'content': base64.b64encode(raw).decode(),
        'encoding': 'base64',
    })
    mode = '100755' if os.access(work_files[p], os.X_OK) else '100644'
    tree_entries.append({'path': p, 'mode': mode, 'type': 'blob', 'sha': blob['sha']})
for p in sorted(deleted):
    tree_entries.append({'path': p, 'mode': '100644', 'type': 'blob', 'sha': None})

new_tree = api('POST', '/git/trees', {'base_tree': base_tree, 'tree': tree_entries})
new_commit = api('POST', '/git/commits', {
    'message': MESSAGE,
    'tree': new_tree['sha'],
    'parents': [head],
})
api('PATCH', '/git/refs/heads/main', {'sha': new_commit['sha'], 'force': False})
print(f'已推送：新 commit = {new_commit["sha"]}')

# 回读校验：远端 blob sha 必须等于本地文件内容的 git blob sha
import subprocess
bad = []
for p in sorted(changed):
    remote = api('GET', f'/contents/{urllib.parse.quote(p)}?ref={new_commit["sha"]}')
    local_sha = hashlib.sha1(f'blob {len(open(work_files[p], "rb").read())}\0'.encode() +
                              open(work_files[p], 'rb').read()).hexdigest()
    if remote['sha'] != local_sha:
        bad.append(p)
for p in sorted(deleted):
    try:
        api('GET', f'/contents/{urllib.parse.quote(p)}?ref={new_commit["sha"]}')
        bad.append(p + ' (应该已删除但还在)')
    except SystemExit:
        pass
print('回读校验：', '✅ 全部一致' if not bad else f'❌ 不一致 {bad}')
