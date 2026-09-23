"""One previous runtime and tool pair; no user-data restore or version matrix."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

TOOLS = ('build-info.json', 'CodexLabelsHelper.exe')


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def directory(root):
    folder = Path(root).resolve()/'.updates'
    if folder.resolve() != folder:
        raise RuntimeError('업데이트 폴더 연결 경로는 사용할 수 없습니다.')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def save(root, value):
    target = directory(root)/'recovery.json'
    temporary = target.with_name('recovery.tmp-' + uuid.uuid4().hex)
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, target)


def state(root):
    try:
        value = json.loads((Path(root)/'.updates/recovery.json').read_text(encoding='utf-8'))
        return value if value.get('schemaVersion') == 1 else {}
    except (OSError, ValueError, AttributeError):
        return {}


def tool_backup(root, version):
    """Reuse backups made by both old and new installStaged implementations."""
    candidates = sorted(directory(root).glob('stage-*/previous'), key=lambda p: p.stat().st_mtime, reverse=True)
    for folder in candidates:
        if folder.resolve() != folder or folder.parent.resolve() != folder.parent:
            continue
        try:
            info = json.loads((folder/'build-info.json').read_text(encoding='utf-8'))
            if info.get('version') != version or any(not (folder/name).is_file() or (folder/name).is_symlink() for name in TOOLS):
                continue
            return {'directory': folder.relative_to(Path(root).resolve()).as_posix(),
                    'hashes': {name: digest(folder/name) for name in TOOLS}}
        except (OSError, ValueError):
            continue
    return None


def checkpoint(root, backup, old_receipt, new_payload, source=None):
    save(root, {'schemaVersion': 1, 'phase': 'switching', 'payload': new_payload, 'source': source,
                'runtimeBackup': backup.name if backup else None,
                'previousHash': old_receipt.get('patchedAsarSha256'),
                'previousPayload': old_receipt.get('helperPayloadSha256'),
                'previousVersion': old_receipt.get('helperVersion'),
                'tools': tool_backup(root, old_receipt.get('helperVersion')),
                'notice': None})


def prepared(root):
    value = state(root)
    if value.get('phase') == 'switching':
        value['phase'] = 'pending'
        save(root, value)


def failed(root, message, payload):
    value = state(root)
    value.update(schemaVersion=1, phase='failed', blockedPayload=payload,
                 notice='업데이트를 적용하지 못해 이전 버전을 사용합니다. ' + str(message)[:500])
    save(root, value)


def complete(root):
    value = state(root)
    if value.get('phase') == 'pending':
        value.update(phase='active', notice=None)
        value.pop('blockedPayload', None)
        save(root, value)
        prune(root, value)


def prune(root, value):
    """Keep only the one backup that rollback can use; each is a full app copy."""
    keep = backup_path(root, value)
    for folder in (Path(root).resolve()/'runtime').glob('app.backup-*'):
        if folder != keep and folder.resolve() == folder and folder.is_dir():
            shutil.rmtree(folder, ignore_errors=True)


def source_failed(root, source, payload, message):
    """Do not rebuild for the same Codex build until it or Labels changes."""
    value = state(root)
    if value.get('phase') == 'switching':
        # prepare() already moved the previous runtime back into place.
        value.update(phase='active', runtimeBackup=None)
    value.update(schemaVersion=1, blockedSource=source, blockedSourcePayload=payload,
                 notice='새 Codex에 맞춘 준비에 실패해 이전 실행본을 사용합니다. ' + str(message)[:500])
    save(root, value)


def backup_path(root, value):
    name = value.get('runtimeBackup')
    if not isinstance(name, str) or not re.fullmatch(r'app\.backup-[a-zA-Z0-9-]+', name):
        return None
    target = Path(root).resolve()/'runtime'/name
    return target if target.resolve() == target else None


def restore(root, valid_runtime, running_apps):
    root = Path(root).resolve()
    current = root/'runtime/app'
    if (current/'ChatGPT.exe').resolve() in running_apps():
        raise RuntimeError('Labels가 종료되면 이전 버전으로 복구할 수 있습니다. 강제로 종료하지 않았습니다.')
    value = state(root)
    backup = backup_path(root, value)
    tools = value.get('tools')
    tool_folder = None
    if tools:
        relative = tools.get('directory', '')
        if not re.fullmatch(r'\.updates/stage-[a-zA-Z0-9_-]+/previous', relative):
            raise RuntimeError('이전 실행 도구의 경로가 올바르지 않습니다.')
        tool_folder = root/relative
        if any(p.resolve() != p for p in (tool_folder, tool_folder.parent, tool_folder.parent.parent)):
            raise RuntimeError('이전 실행 도구가 연결 경로에 있습니다.')
        for name in TOOLS:
            if (tool_folder/name).is_symlink() or digest(tool_folder/name) != tools.get('hashes', {}).get(name):
                raise RuntimeError('이전 실행 도구가 변경되어 복구를 중단했습니다.')
    already_restored = (valid_runtime(root, current) and digest(current/'resources/app.asar') == value.get('previousHash')
                        and json.loads((current/'codex-labels-build.json').read_text(encoding='utf-8')).get('helperPayloadSha256') == value.get('previousPayload'))
    if not already_restored and (not backup or not valid_runtime(root, backup) or digest(backup/'resources/app.asar') != value.get('previousHash')):
        raise RuntimeError('복구할 정상 실행본을 찾지 못했습니다.')
    value.update(phase='restoring', blockedPayload=value.get('payload') or value.get('blockedPayload'),
                 blockedSource=value.get('source'), blockedSourcePayload=value.get('payload'))
    save(root, value)
    if not already_restored:
        if current.exists():
            current.rename(current.with_name('app.failed-' + uuid.uuid4().hex[:8]))
        backup.rename(current)
    # The recovery worker runs from its own copy, so Windows can replace the helper.
    if tool_folder:
        for name in TOOLS:
            temporary = root/(name + '.restore-' + uuid.uuid4().hex)
            shutil.copyfile(tool_folder/name, temporary)
            os.replace(temporary, root/name)
    shutil.copyfile(current/'codex-labels-build.json', root/'build-manifest.json')
    value.update(phase='rolled-back', runtimeBackup=None,
                 notice=value.get('notice') or '이전 버전으로 복구했습니다.')
    save(root, value)
    return value


def attempted(root):
    value = state(root)
    if value.get('phase') == 'pending':
        value['launchAttempted'] = True
        save(root, value)


def schedule(root, script):
    """Detach a copy before restoring a Windows executable that is still running."""
    root = Path(root).resolve()
    if getattr(sys, 'frozen', False):
        worker = directory(root)/('recovery-' + uuid.uuid4().hex)/'CodexLabelsHelper.exe'
        worker.parent.mkdir()
        shutil.copyfile(sys.executable, worker)
        command = [str(worker)]
    else:
        command = [sys.executable, str(script)]
    command += ['rollback-apply', '--root', str(root), '--recovery-parent', str(os.getpid())]
    env = {k: v for k, v in os.environ.items() if not k.startswith('_PYI_')}
    env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    subprocess.Popen(command, cwd=root, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return {'cancelled': True, 'recoveryScheduled': True}


def wait_for_helper(pid, timeout=30):
    if not pid or pid == os.getpid():
        return
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if handle:
            try:
                if kernel.WaitForSingleObject(handle, timeout * 1000) != 0:
                    raise RuntimeError('실행 도구 종료를 기다리고 있습니다. 잠시 후 다시 복구해 주세요.')
            finally:
                kernel.CloseHandle(handle)


def smoke(runtime, example, timeout=45):
    """No real profile, CODEX_HOME, labels or login copied into the trial."""
    with tempfile.TemporaryDirectory(prefix='labels-smoke-', ignore_cleanup_errors=True) as temporary:
        isolated = Path(temporary)
        config = isolated/'config'; config.mkdir()
        shutil.copyfile(example, config/'labels.json')
        (config/'assignments.json').write_text('{"schemaVersion":1,"assignments":{}}', encoding='utf-8')
        env = {k: v for k, v in os.environ.items() if not k.startswith('_PYI_')}
        env.update(CODEX_HOME=str(isolated/'codex'), CODEX_ELECTRON_USER_DATA_PATH=str(isolated/'profile'),
                   CODEX_LABELS_SMOKE_DIRECTORY=str(config), CODEX_LABELS_LAUNCH_TOKEN=uuid.uuid4().hex)
        env.pop('ELECTRON_RUN_AS_NODE', None)
        process = subprocess.Popen([str(runtime/'ChatGPT.exe'), '--user-data-dir=' + str(isolated/'profile')],
                                   cwd=runtime, env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            process.wait(timeout=timeout)
            report = json.loads((config/'runtime-status.json').read_text(encoding='utf-8'))
            if report.get('status') not in ('active', 'stopped') or not report.get('settingsAvailable') or report.get('launchToken') != env['CODEX_LABELS_LAUNCH_TOKEN'] or not report.get('smokePassed'):
                raise RuntimeError('격리 실행에서 라벨 준비를 확인하지 못했습니다.')
        except Exception as error:
            reports = []
            for file in config.glob('runtime-status*.json'):
                try:
                    value = json.loads(file.read_text(encoding='utf-8'))
                    reports.append({key: value.get(key) for key in ('status', 'settingsAvailable', 'smokePassed', 'smokeError', 'rows')})
                except (OSError, ValueError): pass
            (runtime/'codex-labels-smoke.json').write_text(json.dumps({'ok': False, 'reports': reports, 'error': type(error).__name__}), encoding='utf-8')
            # Only our isolated disposable trial may be stopped; never the user's app.
            if process.poll() is None:
                if sys.platform == 'win32':
                    subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                   capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    process.terminate()
                process.wait(timeout=10)
            raise RuntimeError('새 실행본의 격리 검사에 실패했습니다. 기존 버전을 유지합니다.') from error
