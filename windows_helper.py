"""Per-PC preparation and launch helper; distributable without Python installed."""
import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
import re
import runtime_recovery as recovery

import prepare_runtime as builder
import account_profiles

VERSION = '0.3.0'
ASSETS = Path(__file__).resolve().parent
HELPER_NAME = 'CodexLabelsHelper.exe'


def default_root():
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else ASSETS


def powershell(script, extra_env=None):
    if sys.platform != 'win32':
        raise RuntimeError('이 도구는 Windows x64용입니다.')
    env = os.environ.copy()
    env.update(extra_env or {})
    # Paths are data in the environment, never interpolated into script code.
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); " + script],
        env=env, capture_output=True, encoding='utf-8', errors='replace',
        creationflags=subprocess.CREATE_NO_WINDOW, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or 'Windows 환경을 확인하지 못했습니다.')
    return result.stdout.strip()


def installed_sources():
    text = powershell("@(Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }) | ConvertTo-Json -Compress")
    values = json.loads(text) if text else []
    return [Path(value)/'app' for value in ([values] if isinstance(values, str) else values)]


def find_source(explicit=None):
    if explicit is not None:
        source = Path(explicit).resolve()
        builder.validate_source(source)
        return source
    candidates = installed_sources()
    if not candidates and builder.SOURCE.is_dir():
        candidates = [builder.SOURCE]
    for candidate in candidates:
        try:
            builder.validate_source(candidate)
            return candidate.resolve()
        except (ValueError, KeyError, OSError, RuntimeError):
            continue
    raise RuntimeError('지원하는 공식 Codex 설치본을 찾지 못했습니다. '
        '이 패키지는 ' + builder.VERSION + ' / 내부 앱 ' + builder.SUPPORTED_APP_VERSION +
        '용입니다. 다른 버전은 호환 패키지가 필요합니다. 원본 앱은 변경하지 않았습니다.')


def profile_path():
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        raise RuntimeError('LOCALAPPDATA 경로를 확인할 수 없습니다.')
    return Path(local)/'CodexLabels'/'User Data'


def running_apps():
    text = powershell("@(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" | "
        "Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($env:LABELS_PROFILE_CHECK) -or $_.CommandLine.Contains('--codex-labels-account=')) } | "
        "Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress",
        {'LABELS_PROFILE_CHECK': str(profile_path())})
    values = json.loads(text) if text else []
    return [Path(value).resolve() for value in ([values] if isinstance(values, str) else values) if value]


@contextmanager
def preparation_lock(root):
    """A kernel mutex releases on crashes; it leaves no stale lock file."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    name = 'Local\\CodexLabelsPrepare-' + hashlib.sha256(str(root).casefold().encode()).hexdigest()
    handle = kernel.CreateMutexW(None, False, name)
    if not handle:
        raise OSError('설치 잠금을 만들지 못했습니다.')
    try:
        if ctypes.get_last_error() == 183:
            raise RuntimeError('이 폴더의 설치 또는 업데이트가 이미 진행 중입니다.')
        yield
    finally:
        kernel.CloseHandle(handle)


def payload_fingerprint():
    digest = hashlib.sha256()
    files = [ASSETS/name for name in ('prepare_runtime.py', 'windows_helper.py', 'updater.py', 'launcher_ui.py', 'runtime_recovery.py', 'account_profiles.py', 'account_manager.py', 'account_cleanup.py', 'labels.example.json')]
    files += sorted((ASSETS/'extension').glob('*.js'))
    files += sorted(path for path in (ASSETS/'extension').glob('*.cjs') if not path.name.endswith('.test.cjs'))
    for file in files:
        digest.update(file.name.encode()); digest.update(file.read_bytes())
    return digest.hexdigest()


def read_receipt(root):
    receipt = root/'runtime/app/codex-labels-build.json'
    if not receipt.is_file():
        return None
    try:
        value = json.loads(receipt.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else None
    except (ValueError, OSError):
        return None


def require_ready(root):
    root = Path(root).resolve()
    receipt = read_receipt(root)
    exe = root/'runtime/app/ChatGPT.exe'
    if not receipt or receipt.get('version') != 3 or not exe.is_file():
        raise RuntimeError('먼저 설치.cmd를 실행해 이 PC의 라벨 실행본을 준비하세요.')
    if Path(receipt.get('configPath', '')).resolve() != root/'labels.json':
        raise RuntimeError('폴더 위치가 바뀌었습니다. 현재 폴더에서 설치.cmd를 다시 실행하세요.')
    if receipt.get('helperPayloadSha256') != payload_fingerprint():
        raise RuntimeError('새 버전 파일이 있습니다. 설치.cmd로 업데이트한 뒤 실행하세요.')
    return exe


def write_json(path, value):
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def valid_runtime(root, target):
    root = Path(root).resolve()
    target = Path(target)
    expected = root/'runtime'/target.name
    try:
        receipt = json.loads((target/'codex-labels-build.json').read_text(encoding='utf-8'))
        return (receipt.get('version') == 3 and Path(receipt.get('configPath', '')).resolve() == root/'labels.json'
                and target.resolve() == expected and (target/'ChatGPT.exe').is_file()
                and builder.file_hash(target/'resources/app.asar') == receipt.get('patchedAsarSha256'))
    except (OSError, ValueError, TypeError):
        return False


def recover_runtime(root):
    """Recover the tiny publish window, including pre-journal legacy updates."""
    root = Path(root).resolve()
    target = root/'runtime/app'
    if target.exists():
        return
    for backup in sorted((root/'runtime').glob('app.backup-*'), reverse=True):
        if valid_runtime(root, backup):
            backup.rename(target)
            write_json(root/'build-manifest.json', read_receipt(root))
            return


def move_runtime(source, target):
    """Windows can briefly retain directory handles after a child exits."""
    deadline = time.monotonic() + 15
    while True:
        try:
            source.rename(target)
            return
        except OSError as error:
            if getattr(error, 'winerror', None) not in (5, 32) or time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


def prepare(root, source=None, progress=None, *, verify_runtime=False):
    root = Path(root).resolve()
    refresh = source is None
    source = root/'runtime/app' if refresh else Path(source).resolve()
    builder.validate_source(source)  # Validate before creating or moving anything.
    target = root/'runtime/app'
    if source == root or source in root.parents or (root in source.parents and not refresh):
        raise RuntimeError('공식 설치 폴더 밖의 별도 폴더에 압축을 풀어 주세요.')
    if (root/'runtime').resolve() != root/'runtime' or target.resolve() != target:
        raise RuntimeError('runtime 폴더의 바로가기 또는 연결 경로에는 설치할 수 없습니다.')
    if target.exists() and not read_receipt(root):
        raise RuntimeError('빌드 기록이 없는 runtime/app 폴더가 있습니다. 다른 빈 폴더에서 설치하세요.')
    try:
        require_ready(root)
        if refresh or read_receipt(root).get('sourceAsarSha256') == builder.file_hash(source/'resources/app.asar'):
            return {'ready': True, 'root': str(root), 'backup': None, 'alreadyPrepared': True}
    except RuntimeError:
        pass
    if target.exists() and (target/'ChatGPT.exe').resolve() in running_apps():
        raise RuntimeError('이 폴더의 Codex Labels 창을 닫은 뒤 다시 설치하세요. 원본 Codex는 열어 두어도 됩니다.')
    root.mkdir(parents=True, exist_ok=True)
    needed = sum(file.stat().st_size for file in source.rglob('*') if file.is_file()) + 512 * 1024 * 1024
    if shutil.disk_usage(root).free < needed:
        raise RuntimeError(f'설치 공간이 부족합니다. 약 {needed / (1024**3):.1f}GB의 여유 공간이 필요합니다.')
    if root != ASSETS:
        shutil.copyfile(ASSETS/'labels.example.json', root/'labels.example.json')
    # Build beside the usable runtime. Only the short final publication moves
    # the old app; interruption during the expensive copy cannot remove it.
    incoming = target.with_name('.prepared-' + uuid.uuid4().hex)
    backup = None
    old_receipt = read_receipt(root)
    try:
        builder.prepare_runtime(source, root, destination=incoming, progress=progress, **({'refresh': True} if refresh else {}))
        receipt = json.loads((incoming/'codex-labels-build.json').read_text(encoding='utf-8'))
        receipt.update(helperVersion=VERSION, helperPayloadSha256=payload_fingerprint())
        write_json(incoming/'codex-labels-build.json', receipt)
        if verify_runtime:
            if progress: progress('별도 환경에서 새 실행본을 확인하고 있습니다', 72)
            recovery.smoke(incoming, ASSETS/'labels.example.json')
        if progress: progress('검증된 새 버전으로 교체하고 있습니다', 80)
        if target.exists() and (target/'ChatGPT.exe').resolve() in running_apps():
            raise RuntimeError('설치 중 Labels가 다시 열렸습니다. 현재 실행본을 유지합니다. 앱에서 다시 설치해 주세요.')
        if target.exists():
            previous = target.with_name('app.backup-' + datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8])
            recovery.checkpoint(root, previous, old_receipt, payload_fingerprint())
            move_runtime(target, previous)
            backup = previous
        move_runtime(incoming, target)
        write_json(root/'build-manifest.json', receipt)
        recovery.prepared(root)
    except Exception:
        if backup is not None:
            # Preserve even an incomplete new runtime for diagnosis before restore.
            if target.exists():
                target.rename(target.with_name('app.failed-' + uuid.uuid4().hex[:8]))
            move_runtime(backup, target)
            write_json(root/'build-manifest.json', read_receipt(root))
        raise
    finally:
        # Preserve an interrupted/failed candidate for diagnosis, never delete
        # user data or the previous runtime in this recovery path.
        if incoming.exists():
            try:
                move_runtime(incoming, incoming.with_name('app.failed-' + uuid.uuid4().hex[:8]))
            except OSError:
                pass  # Keep the candidate in place and retain the original failure.
    return {'ready': True, 'root': str(root), 'backup': str(backup) if backup else None}


def create_shortcut(root, destination=None):
    root = Path(root).resolve()
    helper = root/HELPER_NAME
    if not helper.is_file():
        raise RuntimeError('바로가기는 배포 ZIP의 실행 도구에서 만들 수 있습니다.')
    # Environment lookup also supports a OneDrive-redirected Desktop. Do not
    # replace a shortcut owned by another copy or application.
    # WScript.Shell's TargetPath setter can reject Korean paths on an English
    # Windows installation. Use the explicit Unicode Shell Link COM interface.
    script = """
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class LabelsShellLinkObject { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface LabelsShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int count, IntPtr data, uint flags);
    void GetIDList(out IntPtr id);
    void SetIDList(IntPtr id);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
    void GetHotkey(out short key);
    void SetHotkey(short key);
    void GetShowCmd(out int command);
    void SetShowCmd(int command);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
    void Resolve(IntPtr window, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
}
public static class LabelsShortcut {
    public static void Save(string destination, string target, string directory, string icon) {
        object instance = new LabelsShellLinkObject();
        try {
            var link = (LabelsShellLinkW)instance;
            var file = (IPersistFile)instance;
            if (File.Exists(destination)) {
                file.Load(destination, 0);
                var path = new StringBuilder(32768); var arguments = new StringBuilder(32768);
                link.GetPath(path, path.Capacity, IntPtr.Zero, 4);
                link.GetArguments(arguments, arguments.Capacity);
                if (!String.Equals(path.ToString(), target, StringComparison.OrdinalIgnoreCase) || arguments.ToString() != "launch")
                    throw new InvalidOperationException("다른 실행본의 Codex Labels 바로가기가 이미 있습니다. 실행.cmd를 사용하세요.");
            }
            link.SetPath(target); link.SetArguments("launch"); link.SetWorkingDirectory(directory);
            link.SetShowCmd(7); link.SetDescription("Codex Labels 실행"); link.SetIconLocation(icon, 0);
            file.Save(destination, true);
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@
    $destination = $env:LABELS_LINK_DEST
    if (-not $destination) { $destination = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex Labels.lnk' }
    [LabelsShortcut]::Save($destination, $env:LABELS_HELPER_PATH, $env:LABELS_ROOT_PATH, $env:LABELS_ICON_PATH)
    $destination
    """
    return powershell(script, {'LABELS_HELPER_PATH': str(helper), 'LABELS_ROOT_PATH': str(root),
        'LABELS_ICON_PATH': str(root/'runtime/app/ChatGPT.exe'), 'LABELS_LINK_DEST': str(destination or '')})


def update_status(root):
    receipt = read_receipt(root)
    saved = recovery.state(root)
    blocked = saved.get('blockedPayload') == payload_fingerprint()
    backup = recovery.backup_path(root, saved)
    return {'currentVersion': receipt.get('helperVersion') if receipt else None,
            'downloadedVersion': receipt.get('helperVersion') if blocked and receipt else VERSION,
            'pendingRestart': not blocked and (not receipt or receipt.get('helperPayloadSha256') != payload_fingerprint()),
            'rollbackAvailable': bool(backup and (backup/'codex-labels-build.json').is_file()),
            'recoveryNotice': saved.get('notice'), 'updateBlocked': blocked}


def codex_status(root):
    """Read-only comparison, including newer unsupported official installs."""
    base = None
    try:
        root = Path(root).resolve()
        receipt = read_receipt(root) or {}
        base = receipt.get('sourceAppVersion') or builder.source_version(root/'runtime/app')
        sources = installed_sources()
        if not sources and builder.SOURCE.is_dir():
            sources = [builder.SOURCE]
        installed = {builder.source_version(source) for source in sources}
        def parts(value):
            if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r'\d+(?:\.\d+)+', value):
                raise ValueError('Invalid installed version')
            return tuple(map(int, value.split('.')))
        original = max(installed, key=parts)
        base_parts, original_parts = parts(base), parts(original)
        return {'state': 'changed' if base_parts != original_parts else 'same',
                'baseVersion': base, 'installedVersion': original,
                'newer': original_parts > base_parts}
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError):
        return {'state': 'unavailable', 'baseVersion': base, 'installedVersion': None, 'newer': False}


def wait_for_parent(pid, root, token, progress, timeout=120):
    """Only observe the specified Labels process; never terminate any app."""
    import ctypes
    from ctypes import wintypes
    if not re.fullmatch(r'[0-9a-f]{32}', token or '') or pid <= 0:
        raise ValueError('잘못된 재시작 요청입니다.')
    cancelled = root/'.restarts'/(token+'.cancel')
    if cancelled.exists():
        return False
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    handle = kernel.OpenProcess(0x100000 | 0x1000, False, pid)
    if not handle:
        raise RuntimeError('종료할 Labels 프로세스를 확인하지 못했습니다. 앱에서 다시 시도해 주세요.')
    try:
        size = wintypes.DWORD(32768); buffer = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)) or Path(buffer.value).resolve() != root/'runtime/app/ChatGPT.exe':
            raise RuntimeError('다른 앱의 종료 요청은 처리할 수 없습니다.')
        acknowledgements = root/'.restarts'
        if acknowledgements.resolve() != acknowledgements:
            raise RuntimeError('재시작 폴더가 다른 경로로 연결되어 있습니다.')
        acknowledgements.mkdir(exist_ok=True)
        if cancelled.exists():
            return False
        write_json(acknowledgements/(token+'.json'), {'ready': True, 'processId': os.getpid(), 'token': token})
        progress('Labels가 종료되기를 기다리고 있습니다', 10)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cancelled.exists():
                return False
            if kernel.WaitForSingleObject(handle, 250) == 0:
                return not cancelled.exists()
        raise RuntimeError('앱 종료가 취소되었거나 지연되었습니다. 현재 앱은 변경하지 않았습니다.')
    finally:
        kernel.CloseHandle(handle)


def wait_until_active(root, process, started, timeout=75, allow_forwarded=False, status_directory=None, account_id=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status = json.loads(((status_directory or root)/'runtime-status.json').read_text(encoding='utf-8'))
            updated = datetime.fromisoformat(status['updatedAt'].replace('Z', '+00:00')).timestamp()
            identity_matches = (status.get('launchToken') == process.labels_launch_token or
                                process.labels_launch_token in status.get('recentLaunchTokens', []) or
                                (not status.get('launchToken') and status.get('processId') == process.pid))
            if (status.get('status') == 'active' and identity_matches
                    and updated >= started and Path(status['executable']).resolve() == root/'runtime/app/ChatGPT.exe'
                    and (account_id is None or status.get('accountProfileId') == account_id)):
                return status
        except (OSError, ValueError, KeyError, TypeError):
            pass
        if process.poll() is not None and not allow_forwarded:
            raise RuntimeError('Labels가 준비되기 전에 종료되었습니다. 다시 시도해 주세요.')
        time.sleep(0.2)
    raise RuntimeError('앱 화면의 준비 완료를 확인하지 못했습니다. 열린 Labels 창을 확인해 주세요.')


def delete_account(root, account_id, *, progress=None, shared=False):
    import account_cleanup
    root = Path(root).resolve()
    with preparation_lock(root):
        data_root = account_profiles.shared_root() if shared else root
        return account_cleanup.delete_account(data_root, account_id, progress=progress,
            stop=lambda data, key: account_cleanup.stop_account(data, key, runtime_root=root))


def launch_account(root, account_id, *, progress=None, wait_ready=True, shared=False):
    root = Path(root).resolve()
    progress = progress or (lambda *_: None)
    # Account windows never silently fall back to the default launcher or an
    # older runtime without account isolation support.
    with preparation_lock(root):
        exe = require_ready(root)
        if shared and (read_receipt(root).get('accountHostProtocol') != 1 or not valid_runtime(root, root/'runtime/app')):
            raise RuntimeError('이 실행본은 공통 계정 연결 규칙을 지원하지 않습니다.')
        data_root = account_profiles.shared_root() if shared else root
        account, directory, profile, env = account_profiles.launch_context(data_root, account_id)
        for name, initial in [('labels.json', (ASSETS/'labels.example.json').read_bytes()),
                              ('assignments.json', b'{"schemaVersion":1,"assignments":{}}\n')]:
            try:
                with (directory/name).open('xb') as file: file.write(initial)
            except FileExistsError: pass
        progress(account['name'] + ' 창을 열고 있습니다', 80)
        started = time.time()
        process = subprocess.Popen([str(exe), '--user-data-dir=' + str(profile),
            '--codex-labels-account=' + account_id,
            *(['--codex-labels-account-protocol=1'] if shared else []),
            '--codex-labels-launch-token=' + env['CODEX_LABELS_LAUNCH_TOKEN']], cwd=exe.parent,
            env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        process.labels_launch_token = env['CODEX_LABELS_LAUNCH_TOKEN']
        status = {'version': 3, 'status': 'launch-requested', 'processId': process.pid,
                  'accountProfileId': account_id, 'profile': str(profile), 'executable': str(exe)}
        write_json(directory/'launch-status.json', status)
        if wait_ready:
            active = wait_until_active(root, process, started, allow_forwarded=True,
                                       status_directory=directory, account_id=account_id)
            status.update(status='active', processId=active['processId'])
            write_json(directory/'launch-status.json', status)
        return status


def launch(root, *, progress=None, wait_ready=False, source=None, shortcut=False, skip_update=False, select_accounts=False):
    root = Path(root).resolve()
    progress = progress or (lambda *_: None)
    progress('설치 상태를 확인하고 있습니다', 5)
    update_error = None
    root.mkdir(parents=True, exist_ok=True)
    with preparation_lock(root):
        recover_runtime(root)
        saved = recovery.state(root)
        pending_restore = saved.get('phase') in ('failed', 'restoring', 'switching') or (saved.get('phase') == 'pending' and saved.get('launchAttempted'))
        if not skip_update and pending_restore and saved.get('runtimeBackup'):
            if (root/'runtime/app/ChatGPT.exe').resolve() in running_apps():
                raise RuntimeError('Labels를 닫으면 이전 버전으로 복구합니다. 강제로 종료하지 않았습니다.')
            return recovery.schedule(root, Path(__file__))
        try:
            if (skip_update or saved.get('blockedPayload') == payload_fingerprint()) and valid_runtime(root, root/'runtime/app'):
                exe = root/'runtime/app/ChatGPT.exe'
                update_error = saved.get('notice')
            else:
                exe = require_ready(root)
        except RuntimeError:
            if (root/'runtime/app/ChatGPT.exe').resolve() in running_apps():
                raise RuntimeError('실행 중인 Labels의 라벨 설정에서 설치하고 다시 실행을 눌러 주세요. 처음 적용할 때는 기존 Labels를 완전히 종료해 주세요.')
            try:
                base = None if source is None and valid_runtime(root, root/'runtime/app') else find_source(source)
                prepare(root, base, progress, verify_runtime=getattr(sys, 'frozen', False))
                exe = require_ready(root)
            except Exception as error:
                exe = root/'runtime/app/ChatGPT.exe'
                if not valid_runtime(root, exe.parent):
                    raise
                update_error = str(error)
                recovery.checkpoint(root, None, read_receipt(root), payload_fingerprint())
                recovery.failed(root, error, payload_fingerprint())
                if recovery.state(root).get('tools'):
                    return recovery.schedule(root, Path(__file__))
    if shortcut:
        create_shortcut(root)
    if select_accounts:
        progress('계정 선택기를 준비했습니다', 100)
        return {'selectorReady': True, 'updateError': update_error}
    existing = running_apps()
    if any(app != exe.resolve() for app in existing):
        raise RuntimeError('다른 폴더의 Codex Labels가 실행 중입니다. 해당 Labels 창을 닫고 다시 실행하세요.')
    profile = profile_path()
    profile.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env['CODEX_ELECTRON_USER_DATA_PATH'] = str(profile)
    env['CODEX_LABELS_LAUNCH_TOKEN'] = uuid.uuid4().hex
    env.pop('ELECTRON_RUN_AS_NODE', None)
    # The one-file helper's extraction directory is deleted when it exits.
    # Do not let the app or a later same-path helper inherit that directory.
    for name in list(env):
        if name.startswith('_PYI_'):
            del env[name]
    progress('Codex Labels를 열고 있습니다', 90)
    started = time.time()
    if wait_ready and not skip_update:
        recovery.attempted(root)
    try:
        process = subprocess.Popen([str(exe), '--user-data-dir=' + str(profile), '--codex-labels-launch-token=' + env['CODEX_LABELS_LAUNCH_TOKEN']], cwd=exe.parent,
            env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except OSError as error:
        saved = recovery.state(root)
        if not skip_update and saved.get('phase') == 'pending' and saved.get('runtimeBackup'):
            recovery.failed(root, error, payload_fingerprint())
            return recovery.schedule(root, Path(__file__))
        raise
    process.labels_launch_token = env['CODEX_LABELS_LAUNCH_TOKEN']
    status = {'version': 3, 'status': 'launch-requested', 'processId': process.pid,
        'executable': str(exe), 'profile': str(profile), 'originalAppStopped': False}
    write_json(root/'launch-status.json', status)
    if wait_ready:
        try:
            active = wait_until_active(root, process, started, allow_forwarded=bool(existing))
        except RuntimeError as error:
            saved = recovery.state(root)
            if not skip_update and saved.get('phase') == 'pending' and saved.get('runtimeBackup'):
                recovery.failed(root, error, payload_fingerprint())
                if process.poll() is not None:
                    return recovery.schedule(root, Path(__file__))
                raise RuntimeError('새 버전의 준비를 확인하지 못했습니다. Labels를 닫고 다시 실행하면 이전 버전으로 복구합니다.') from error
            raise
        recovery.complete(root)
        status.update(status='active', processId=active['processId'], updateError=update_error)
        write_json(root/'launch-status.json', status)
        progress('Codex Labels가 열렸습니다', 100)
    return status


def open_accounts(root):
    import account_manager
    data_root = account_profiles.shared_root()
    return account_manager.run(data_root,
        lambda _, key, **kw: launch_account(root, key, shared=True, **kw),
        lambda _, key, **kw: delete_account(root, key, shared=True, **kw),
        launch_default=lambda **kw: launch(root, wait_ready=True, skip_update=True, **kw),
        close_on_launch=True)


def main():
    if sys.stdout:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description='Codex Labels Windows 설치·실행 도구')
    parser.add_argument('action', choices=['accounts', 'account-create', 'account-list', 'account-launch', 'account-delete', 'prepare', 'launch', 'launch-direct', 'check', 'update-check', 'update-stage', 'update-status', 'codex-status', 'rollback', 'rollback-apply'], nargs='?', default='launch')
    parser.add_argument('--account-id')
    parser.add_argument('--name')
    parser.add_argument('--confirm-delete', action='store_true', help='선택한 계정의 로컬 자료 영구 삭제 확인')
    parser.add_argument('--root', type=Path, default=default_root())
    parser.add_argument('--source', type=Path)
    parser.add_argument('--shortcut', action='store_true')
    parser.add_argument('--wait-pid', type=int)
    parser.add_argument('--restart-token')
    parser.add_argument('--recovery-parent', type=int, help=argparse.SUPPRESS)
    parser.add_argument('--no-ui', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--version', action='version', version=VERSION)
    args = parser.parse_args()
    # Old installer shortcuts used prepare --shortcut. Keep them on the new
    # single install-and-open flow when used interactively.
    if args.action == 'prepare' and args.shortcut and not args.no_ui:
        args.action = 'launch'
    root = args.root.resolve()
    try:
        if sys.platform != 'win32':
            raise RuntimeError('Windows x64 PC에서 실행하세요.')
        if args.action == 'accounts' or (args.action == 'launch' and not args.wait_pid):
            def prepare_selector(progress):
                return launch(root, source=args.source, shortcut=args.shortcut,
                              progress=progress, select_accounts=True)
            if getattr(sys, 'frozen', False):
                import ctypes
                ctypes.windll.kernel32.FreeConsole()
            if not args.no_ui:
                import launcher_ui
                code = launcher_ui.run(prepare_selector)
                if code:
                    return code
                return open_accounts(root)
            result = prepare_selector(lambda message, percent: print(message, flush=True))
        elif args.action == 'account-create':
            if not args.name: raise ValueError('--name으로 계정 창 이름을 지정하세요.')
            result = account_profiles.create(root, args.name)
        elif args.action == 'account-list':
            result = {'accounts': account_profiles.list_accounts(root)}
        elif args.action == 'account-launch':
            result = launch_account(root, args.account_id, wait_ready=not args.no_ui)
        elif args.action == 'account-delete':
            if not args.confirm_delete: raise ValueError('영구 삭제하려면 --confirm-delete를 지정하세요.')
            result = delete_account(root, args.account_id)
        elif args.action == 'codex-status':
            result = codex_status(root)
        elif args.action == 'update-status':
            result = update_status(root)
        elif args.action in ('update-check', 'update-stage'):
            import updater
            if args.action == 'update-check':
                result, _ = updater.release(VERSION)
                result.update(update_status(root))
            else:
                with preparation_lock(root):
                    # Read installed metadata without forcing the OLD helper's
                    # compatibility gate. A newer package may support a newer
                    # Store app; its own builder still validates before patching.
                    try:
                        sources = [args.source.resolve()] if args.source else installed_sources()
                    except (OSError, RuntimeError, subprocess.SubprocessError):
                        sources = []
                    if not sources and builder.SOURCE.is_dir():
                        sources = [builder.SOURCE]
                    versions = set()
                    for source in sources:
                        try: versions.add(builder.source_version(source))
                        except (OSError, ValueError, KeyError): pass
                    if valid_runtime(root, root/'runtime/app'):
                        versions.add(builder.source_version(root/'runtime/app'))
                    if not versions:
                        raise RuntimeError('이 PC의 공식 Codex 설치본을 찾지 못했습니다.')
                    result = updater.stage(root, VERSION, versions)
        elif args.action == 'check':
            source = find_source(args.source)
            try:
                require_ready(root); ready = True
            except RuntimeError:
                ready = False
            result = {'helperVersion': VERSION, 'supportedAppVersion': builder.SUPPORTED_APP_VERSION,
                'source': str(source), 'root': str(root), 'ready': ready, 'originalInstallModified': False}
        elif args.action == 'prepare':
            with preparation_lock(root):
                print('공식 Codex를 확인하고 라벨 기능을 준비하고 있습니다. 잠시 기다려 주세요.', flush=True)
                result = prepare(root, find_source(args.source))
                if args.shortcut:
                    result['shortcut'] = create_shortcut(root)
            print('준비 완료. 다음부터 실행.cmd 또는 바탕화면 바로가기를 사용하세요.', flush=True)
        else:
            parent_exited = False
            def operation(progress):
                nonlocal parent_exited
                if args.action == 'rollback-apply':
                    recovery.wait_for_helper(args.recovery_parent)
                    with preparation_lock(root):
                        recovery.restore(root, valid_runtime, running_apps)
                    return launch(root, progress=progress, wait_ready=not args.no_ui, skip_update=True)
                if args.wait_pid and not parent_exited:
                    if not wait_for_parent(args.wait_pid, root, args.restart_token, progress):
                        return {'cancelled': True}
                    parent_exited = True
                    # Browser children can outlive the main process briefly.
                    deadline = time.monotonic() + 30
                    while running_apps():
                        if time.monotonic() > deadline:
                            raise RuntimeError('Labels의 종료가 아직 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.')
                        time.sleep(0.5)
                try:
                    if args.action == 'rollback':
                        return recovery.schedule(root, Path(__file__))
                    return launch(root, progress=progress, wait_ready=not args.no_ui,
                                  source=args.source, shortcut=args.shortcut)
                except Exception as error:
                    write_json(root/'launch-error.json', {'message': str(error), 'at': time.time()})
                    raise
            if getattr(sys, 'frozen', False) and not args.no_ui:
                import ctypes
                ctypes.windll.kernel32.FreeConsole()
                import launcher_ui
                return launcher_ui.run(operation)
            result = operation(lambda message, percent: print(message, flush=True))
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        message = 'Codex Labels: ' + str(error)
        print(message, flush=True)
        if args.action == 'launch' and getattr(sys, 'frozen', False) and not args.no_ui:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, message, 'Codex Labels', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
