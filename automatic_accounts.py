"""Registered-account handoff for Labels. No Desktop transport interception.

Only file-backed, managed ChatGPT credentials are supported. All plaintext
credentials stay in process memory or private native CLI work directories.
Never print subprocess output, RPC errors, token contents or account files.
"""
from __future__ import annotations
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
import uuid

MAX_AUTH = 1024 * 1024
MAX_VAULT = 32 * MAX_AUTH
PROFILE = re.compile(r'^[0-9a-f]{32}$')

class AccountError(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code

def require(condition, code='INVALID_DATA'):
    if not condition:
        raise AccountError(code)

def no_links(path: Path) -> Path:
    path = Path(os.path.abspath(path))
    for p in (path, *path.parents):
        if p.exists() or p.is_symlink():
            s = p.lstat()
            require(not stat.S_ISLNK(s.st_mode) and not (getattr(s, 'st_file_attributes', 0) & 0x400), 'UNSAFE_PATH')
    return path

def read_private(path: Path, maximum=MAX_AUTH) -> bytes:
    path = no_links(path)
    try:
        with path.open('rb') as f:
            s = os.fstat(f.fileno())
            require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= maximum, 'UNSAFE_PATH')
            value = f.read(maximum + 1)
            require(len(value) <= maximum, 'INVALID_DATA')
            return value
    except OSError:
        raise AccountError('FILE_UNAVAILABLE') from None

def current_sid() -> str:
    import ctypes
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
    advapi.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
    token = w.HANDLE()
    require(advapi.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)), 'PERMISSIONS_FAILED')
    try:
        size = w.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        require(0 < size.value < 65536, 'PERMISSIONS_FAILED')
        buf = ctypes.create_string_buffer(size.value)
        require(advapi.GetTokenInformation(token, 1, buf, size.value, ctypes.byref(size)), 'PERMISSIONS_FAILED')
        sid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
        out = w.LPWSTR()
        require(advapi.ConvertSidToStringSidW(sid, ctypes.byref(out)), 'PERMISSIONS_FAILED')
        try:
            return out.value
        finally:
            kernel.LocalFree(ctypes.cast(out, ctypes.c_void_p))
    finally:
        kernel.CloseHandle(token)

def secure(path: Path, directory=False):
    """Restrict a new file BEFORE writing any credential bytes."""
    no_links(path)
    if os.name != 'nt':
        os.chmod(path, 0o700 if directory else 0o600)
        return
    exe = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'icacls.exe'
    access = '(OI)(CI)F' if directory else 'F'
    r = subprocess.run([str(exe), str(path), '/inheritance:r', '/grant:r', '*' + current_sid() + ':' + access],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=15, check=False)
    require(r.returncode == 0, 'PERMISSIONS_FAILED')

def private_dir(path: Path):
    no_links(path)
    path.mkdir(parents=True, exist_ok=True)
    secure(path, True)

def atomic_write(path: Path, data: bytes):
    no_links(path)
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    try:
        # New file initially has no credential bytes. ACL is applied first.
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        secure(temp)
        with temp.open('wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        no_links(path)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

class DPAPI:
    """Current Windows user/machine only. No plaintext fallback in production."""
    def _crypt(self, data: bytes, decrypt: bool) -> bytes:
        require(os.name == 'nt', 'WINDOWS_REQUIRED')
        import ctypes
        from ctypes import wintypes as w
        class Blob(ctypes.Structure):
            _fields_ = [('size', w.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
        buf = ctypes.create_string_buffer(data)
        source = Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
        result = Blob()
        crypt = ctypes.WinDLL('crypt32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        if decrypt:
            fn = crypt.CryptUnprotectData
            fn.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_void_p, w.DWORD, ctypes.POINTER(Blob)]
            ok = fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result))
        else:
            fn = crypt.CryptProtectData
            fn.argtypes = [ctypes.POINTER(Blob), w.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p,
                           ctypes.c_void_p, w.DWORD, ctypes.POINTER(Blob)]
            ok = fn(ctypes.byref(source), 'Codex Labels account vault', None, None, None, 1, ctypes.byref(result))
        require(ok, 'VAULT_UNAVAILABLE')
        try:
            return ctypes.string_at(result.data, result.size)
        finally:
            kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))
    def seal(self, data): return self._crypt(data, False)
    def open(self, data): return self._crypt(data, True)

def payload(token: str) -> dict:
    try:
        require(isinstance(token, str) and len(token) <= MAX_AUTH)
        bits = token.split('.')
        require(len(bits) == 3)
        value = json.loads(base64.urlsafe_b64decode(bits[1] + '=' * (-len(bits[1]) % 4)))
        require(isinstance(value, dict))
        return value
    except (ValueError, TypeError, KeyError):
        raise AccountError('INVALID_CREDENTIAL') from None

def identity_from_token(token: str) -> tuple[str, str]:
    p = payload(token)
    auth = p.get('https://api.openai.com/auth', {})
    require(isinstance(auth, dict), 'INVALID_CREDENTIAL')
    account = auth.get('chatgpt_account_id')
    user = auth.get('chatgpt_user_id') or auth.get('user_id') or p.get('sub')
    require(all(isinstance(v, str) and 0 < len(v) <= 256 and not any(ord(c) < 32 for c in v)
                for v in (account, user)), 'INVALID_CREDENTIAL')
    return account, user

@dataclass(frozen=True)
class Credential:
    raw: bytes
    identity: tuple[str, str]
    email: str
    @classmethod
    def parse(cls, raw: bytes):
        try:
            require(len(raw) <= MAX_AUTH, 'INVALID_CREDENTIAL')
            v = json.loads(raw)
            require(isinstance(v, dict) and v.get('auth_mode') in (None, 'chatgpt'), 'MANAGED_CHATGPT_REQUIRED')
            require(not v.get('OPENAI_API_KEY'), 'MANAGED_CHATGPT_REQUIRED')
            t = v.get('tokens')
            require(isinstance(t, dict) and all(isinstance(t.get(k), str) and t[k]
                for k in ('access_token', 'id_token', 'refresh_token')), 'MANAGED_CHATGPT_REQUIRED')
            identity = identity_from_token(t['access_token'])
            require(not t.get('account_id') or t['account_id'] == identity[0], 'IDENTITY_MISMATCH')
            ip = payload(t['id_token'])
            ia = ip.get('https://api.openai.com/auth', {})
            if ia.get('chatgpt_account_id'):
                require(ia['chatgpt_account_id'] == identity[0], 'IDENTITY_MISMATCH')
            email = ip.get('email', '')
            require(isinstance(email, str) and len(email) <= 320 and not any(ord(c) < 32 for c in email), 'INVALID_CREDENTIAL')
            return cls(raw, identity, email)
        except (ValueError, TypeError, KeyError, AttributeError):
            raise AccountError('INVALID_CREDENTIAL') from None
    def public(self):
        # Display only. Decoded JWT fields are not independent online proof.
        return {'email': self.email, 'accountSuffix': self.identity[0][-6:]}

class Vault:
    def __init__(self, directory: Path, protector=None):
        self.directory = Path(directory)
        self.protector = protector or DPAPI()
        private_dir(self.directory)
        self.file = self.directory / 'accounts.dpapi'
        self.journal = self.directory / 'pending.dpapi'
    def _load(self, file):
        try:
            return json.loads(self.protector.open(read_private(file, MAX_VAULT)))
        except AccountError: raise
        except Exception: raise AccountError('VAULT_UNAVAILABLE') from None
    def _save(self, file, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        require(len(raw) <= MAX_VAULT, 'VAULT_FULL')
        atomic_write(file, self.protector.seal(raw))
    def _registry(self):
        """Read and validate once per operation; never cache refreshed credentials."""
        v = self._load(self.file) if self.file.exists() else {'version': 1, 'accounts': []}
        require(isinstance(v, dict), 'VAULT_UNAVAILABLE')
        require(v.get('version') == 1 and isinstance(v.get('accounts'), list) and len(v['accounts']) <= 64, 'VAULT_UNAVAILABLE')
        excluded = v.get('excludedImports', [])
        require(isinstance(excluded, list) and all(isinstance(key, str) and re.fullmatch(r'[0-9a-f]{64}', key)
                for key in excluded), 'VAULT_UNAVAILABLE')
        ids = set()
        snapshot = []
        for e in v['accounts']:
            require(isinstance(e, dict) and PROFILE.fullmatch(e.get('id', '')) and e['id'] not in ids, 'VAULT_UNAVAILABLE')
            ids.add(e['id'])
            require(isinstance(e.get('name'), str) and 0 < len(e['name']) <= 80, 'VAULT_UNAVAILABLE')
            snapshot.append((e, Credential.parse(e['auth'].encode())))
        return v, snapshot
    def _snapshot(self):
        return self._registry()[1]
    @staticmethod
    def _identity_key(credential):
        return hashlib.sha256(json.dumps(credential.identity).encode()).hexdigest()
    @staticmethod
    def _entry(credential, name='', old=None):
        label = name.strip() or (old['name'] if old else credential.email or '계정 ' + credential.identity[0][-6:])
        require(0 < len(label) <= 80 and not any(ord(ch) < 32 for ch in label), 'INVALID_NAME')
        return {'id': old['id'] if old else uuid.uuid4().hex, 'name': label, 'auth': credential.raw.decode('utf-8')}
    def entries(self):
        return [entry for entry, _ in self._snapshot()]
    @staticmethod
    def _find(snapshot, profile_id):
        for entry, credential in snapshot:
            if entry['id'] == profile_id:
                return entry, credential
        raise AccountError('PROFILE_NOT_FOUND')
    def list(self):
        return [{'id': e['id'], 'name': e['name'], **c.public()} for e, c in self._snapshot()]
    def get(self, profile_id):
        require(isinstance(profile_id, str) and PROFILE.fullmatch(profile_id), 'INVALID_PROFILE')
        entry, credential = self._find(self._snapshot(), profile_id)
        return entry['name'], credential
    def save(self, c: Credential, name='', profile_id=None, overwrite=True, *, automatic=False):
        registry, snapshot = self._registry()
        if automatic and self._identity_key(c) in registry.get('excludedImports', []):
            return None
        entries = registry['accounts']
        old = next((e for e, credential in snapshot if credential.identity == c.identity), None)
        if profile_id:
            target = next(((e, credential) for e, credential in snapshot if e['id'] == profile_id), None)
            require(target is not None and target[1].identity == c.identity, 'IDENTITY_MISMATCH')
            old = target[0]
        if old and not overwrite: return old['id']
        entry = self._entry(c, name, old)
        if old: entries[entries.index(old)] = entry
        else: require(len(entries) < 64, 'VAULT_FULL'); entries.append(entry)
        if overwrite:
            registry['excludedImports'] = [key for key in registry.get('excludedImports', []) if key != self._identity_key(c)]
        self._save(self.file, registry)
        return entry['id']
    def import_accounts(self, candidates):
        """Merge a batch once, preserving newer cache entries and removed registrations."""
        registry, snapshot = self._registry()
        by_identity = {credential.identity: entry['id'] for entry, credential in snapshot}
        excluded = set(registry.get('excludedImports', []))
        changed = False
        for credential, name in candidates:
            if credential.identity in by_identity or self._identity_key(credential) in excluded:
                continue
            if len(registry['accounts']) >= 64:
                break
            try:
                entry = self._entry(credential, name)
            except AccountError:
                continue
            registry['accounts'].append(entry)
            by_identity[credential.identity] = entry['id']
            changed = True
        if changed:
            self._save(self.file, registry)
        return by_identity
    def remove(self, profile_id):
        require(isinstance(profile_id, str) and PROFILE.fullmatch(profile_id), 'INVALID_PROFILE')
        registry, snapshot = self._registry()
        _, credential = self._find(snapshot, profile_id)
        registry['accounts'] = [e for e, _ in snapshot if e['id'] != profile_id]
        registry['excludedImports'] = sorted(set(registry.get('excludedImports', [])) | {self._identity_key(credential)})
        self._save(self.file, registry)
    def begin(self, source: Credential | None, target: Credential):
        require(not self.journal.exists(), 'RECOVERY_REQUIRED')
        self._save(self.journal, {'version': 1, 'source': source.raw.decode() if source else None, 'targetIdentity': list(target.identity)})
    def rollback(self, home: Path):
        v = self._load(self.journal)
        require(v.get('version') == 1, 'RECOVERY_REQUIRED')
        old = Credential.parse(v['source'].encode()) if v['source'] is not None else None
        current = Credential.parse(read_private(home / 'auth.json'))
        # No overwriting a third-party account that appeared during handoff.
        require(current.identity in (old.identity if old else None, tuple(v['targetIdentity'])), 'AUTH_CHANGED_EXTERNALLY')
        if old:
            atomic_write(home / 'auth.json', old.raw)
        else:
            (home / 'auth.json').unlink()
        self.finish()
        return old
    def finish(self): self.journal.unlink(missing_ok=True)


def import_existing_accounts(vault: Vault, home: Path, legacy_root: Path):
    """Collect local caches before a single registry merge; no online requests."""
    candidates = []
    current = None
    try:
        current = Credential.parse(read_private(home / 'auth.json'))
        candidates.append((current, ''))
    except AccountError:
        pass
    if legacy_root.is_dir():
        directories = sorted(d for d in legacy_root.iterdir() if PROFILE.fullmatch(d.name))
        for directory in directories[:64]:
            try:
                metadata = json.loads(read_private(directory / 'account.json'))
                if not isinstance(metadata, dict) or metadata.get('id') != directory.name or not isinstance(metadata.get('name', ''), str):
                    continue
                credential = Credential.parse(read_private(directory / 'codex-home' / 'auth.json'))
                candidates.append((credential, metadata.get('name', '')))
            except (AccountError, ValueError):
                continue
    imported = vault.import_accounts(candidates)
    return imported.get(current.identity) if current else None

def clean_environment(env: dict, home: Path) -> dict:
    denied = ('CODEX_', 'OPENAI_', 'CHATGPT_', 'ELECTRON_', '_PYI', 'PYINSTALLER_', 'NODE_')
    result = {k: v for k, v in env.items() if not k.upper().startswith(denied)}
    # Corporate TLS settings are retained; routing/API credential overrides are not.
    if env.get('CODEX_CA_CERTIFICATE'): result['CODEX_CA_CERTIFICATE'] = env['CODEX_CA_CERTIFICATE']
    result['CODEX_HOME'] = str(home)
    return result

class NativeRpc:
    """Short-lived native CLI client, NEVER attached to Desktop pipes."""
    def __init__(self, executable: Path, home: Path, *, force_file=False, popen=subprocess.Popen):
        args = [str(executable)]
        if force_file: args += ['-c', 'cli_auth_credentials_store="file"']
        args += ['app-server', '--stdio']
        self.child = popen(args, cwd=str(home), env=clean_environment(os.environ, home),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.q = queue.Queue(maxsize=1024); self.sequence = 0; self.events = []; self.failed = False
        def reader():
            try:
                while True:
                    line = self.child.stdout.readline(4 * MAX_AUTH + 1)
                    if not line: break
                    if len(line) > 4 * MAX_AUTH: break
                    obj = json.loads(line)
                    if not isinstance(obj, dict): break
                    self.q.put_nowait(obj)
            except Exception: pass
            finally:
                self.failed = True
                try: self.q.put_nowait(None)
                except queue.Full: pass
        threading.Thread(target=reader, daemon=True).start()
        try:
            self.call('initialize', {'clientInfo': {'name': 'labels_account_handoff', 'version': '1.0'},
                                    'capabilities': {'experimentalApi': True}})
            self.send({'method': 'initialized'})
        except Exception:
            self.close(); raise
    def send(self, data):
        try:
            self.child.stdin.write((json.dumps(data) + '\n').encode()); self.child.stdin.flush()
        except Exception: raise AccountError('RPC_CLOSED') from None
    def _next(self, deadline):
        try: m = self.q.get(timeout=max(0.01, deadline - time.monotonic()))
        except queue.Empty: raise AccountError('RPC_TIMEOUT') from None
        require(m is not None, 'RPC_CLOSED')
        if 'method' in m and 'id' in m:
            # No host-supplied token login; built-in managed credentials only.
            self.send({'id': m['id'], 'error': {'code': -32601, 'message': 'Not supported by account verification client'}})
            raise AccountError('UNEXPECTED_SERVER_REQUEST')
        return m
    def call(self, method, params=None, timeout=30):
        self.sequence += 1; rid = self.sequence
        self.send({'id': rid, 'method': method, 'params': params or {}})
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            m = self._next(deadline)
            if m.get('id') == rid:
                require('error' not in m and 'result' in m, 'NATIVE_REQUEST_FAILED')
                return m['result']
            if 'method' in m and len(self.events) < 256: self.events.append(m)
        raise AccountError('RPC_TIMEOUT')
    def wait_login(self, login_id, cancelled=lambda: False, timeout=240):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cancelled():
                try: self.call('account/login/cancel', {'loginId': login_id}, timeout=5)
                except AccountError: pass
                raise AccountError('CANCELLED')
            for m in self.events[:]:
                if m.get('method') == 'account/login/completed' and m.get('params', {}).get('loginId') == login_id:
                    self.events.remove(m)
                    require(m['params'].get('success') is True, 'LOGIN_FAILED')
                    return
            try: m = self._next(min(deadline, time.monotonic() + 0.5))
            except AccountError as e:
                if e.code == 'RPC_TIMEOUT': continue
                raise
            if len(self.events) < 256: self.events.append(m)
        raise AccountError('LOGIN_TIMEOUT')
    def close(self):
        # Disposable probe only, never stop a Desktop/native task process.
        try: self.child.stdin.close()
        except Exception: pass
        try: self.child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.child.kill(); self.child.wait(timeout=5)
        for stream in (self.child.stdout, self.child.stderr):
            if stream:
                try: stream.close()
                except Exception: pass

class NativeVerifier:
    def __init__(self, executable: Path, vault: Vault, rpc_factory=NativeRpc):
        self.executable, self.vault, self.rpc_factory = executable, vault, rpc_factory
    @contextmanager
    def scratch(self):
        p = Path(tempfile.mkdtemp(prefix='auth-', dir=self.vault.directory))
        secure(p, True)
        try: yield p
        finally: shutil.rmtree(p)  # Ordinary deletion, not secure erasure.
    @contextmanager
    def rpc(self, home, force_file=False):
        client = self.rpc_factory(self.executable, home, force_file=force_file)
        try: yield client
        finally: client.close()
    def _verify(self, c, expected):
        account = c.call('account/read', {'refreshToken': True})
        require(account.get('account', {}).get('type') == 'chatgpt', 'LOGIN_REQUIRED')
        status = c.call('getAuthStatus', {'includeToken': True, 'refreshToken': True})
        live = identity_from_token(status.get('authToken'))
        require(live == expected, 'IDENTITY_MISMATCH')
        c.call('account/rateLimits/read')  # Online auth acceptance; no model requests.
        status = c.call('getAuthStatus', {'includeToken': True, 'refreshToken': False})
        require(identity_from_token(status.get('authToken')) == expected, 'IDENTITY_MISMATCH')
    def browser_login(self, expected=None, cancelled=lambda: False):
        import webbrowser
        from urllib.parse import urlsplit
        with self.scratch() as p:
            with self.rpc(p, True) as c:
                value = c.call('account/login/start', {'type': 'chatgpt'})
                url = value.get('authUrl'); require(isinstance(url, str), 'LOGIN_FAILED')
                u = urlsplit(url)
                require(u.scheme == 'https' and u.hostname == 'auth.openai.com' and not u.username and not u.password
                        and u.port in (None, 443), 'LOGIN_URL_REJECTED')
                require(isinstance(value.get('loginId'), str), 'LOGIN_FAILED')
                require(webbrowser.open(url), 'BROWSER_UNAVAILABLE')
                c.wait_login(value['loginId'], cancelled)
                cred = Credential.parse(read_private(p / 'auth.json'))
                if expected: require(cred.identity == expected, 'IDENTITY_MISMATCH')
                self._verify(c, cred.identity)
            return Credential.parse(read_private(p / 'auth.json'))

class Handoff:
    def __init__(self, home: Path, vault: Vault, desktop, progress=lambda code: None):
        self.home, self.vault, self.desktop, self.progress = home, vault, desktop, progress
    def switch(self, profile_id):
        require(not self.vault.journal.exists(), 'RECOVERY_REQUIRED')
        name, target = self.vault.get(profile_id)
        original = self._current()
        if original and target.identity == original.identity: return {'changed': False, 'state': 'already-selected'}
        original = self._close_source()
        self._activate(original, target)
        self.progress('reopening')
        self.desktop.reopen()
        self.progress('done')
        return {'changed': True, 'state': 'cache-reopened', 'profile': name,
                'desktopIdentityObserved': False, 'usageAttributionTested': False}

    def _current(self):
        auth = self.home / 'auth.json'
        return Credential.parse(read_private(auth)) if auth.exists() else None

    def _close_source(self):
        self.progress('closing')
        self.desktop.close_and_wait()  # Native quit; timeout => no credential change.
        # Source may have refreshed during shutdown. Preserve the LAST source cache.
        original = self._current()
        if original:
            self.vault.save(original, automatic=True)
        return original

    def _activate(self, original, prepared):
        """Write the selected cache atomically, retaining crash recovery."""
        self.vault.begin(original, prepared)
        touched = False
        try:
            self.progress('activating')
            atomic_write(self.home / 'auth.json', prepared.raw); touched = True
            self.vault.finish()
        except Exception as error:
            # No relaunch until uncertain activation has been resolved.
            if touched:
                try:
                    self.vault.rollback(self.home)
                except Exception:
                    raise AccountError('RECOVERY_REQUIRED') from None
            else: self.vault.finish()
            raise AccountError(error.code if isinstance(error, AccountError) else 'HANDOFF_FAILED') from None
    def recover(self):
        self.vault.rollback(self.home)
        self.desktop.reopen()
        return {'state': 'source-restored'}

def vault_path(home: Path) -> Path:
    local = os.environ.get('LOCALAPPDATA')
    require(bool(local), 'WINDOWS_REQUIRED')
    key = hashlib.sha256(home.resolve().as_posix().lower().encode()).hexdigest()
    return Path(local) / 'CodexLabels' / 'AutoAccounts' / key

@contextmanager
def workspace_mutex(home):
    require(os.name == 'nt', 'WINDOWS_REQUIRED')
    import ctypes
    from ctypes import wintypes as w
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateMutexW.argtypes = [ctypes.c_void_p, w.BOOL, w.LPCWSTR]; k.CreateMutexW.restype = w.HANDLE
    k.CloseHandle.argtypes = [w.HANDLE]
    name = 'Local\\CodexLabelsAutoAccount-' + hashlib.sha256(home.resolve().as_posix().lower().encode()).hexdigest()
    handle = k.CreateMutexW(None, False, name)
    require(bool(handle), 'LOCK_FAILED')
    try:
        require(ctypes.get_last_error() != 183, 'ALREADY_OPEN')
        yield
    finally: k.CloseHandle(handle)

class WindowsDesktop:
    def __init__(self, root, home, profile, parent_pid, profile_id=None):
        import psutil
        self.psutil = psutil
        self.root, self.home, self.profile = map(lambda p: no_links(Path(p)).resolve(), (root, home, profile))
        self.exe = self.root / 'runtime' / 'app' / 'ChatGPT.exe'
        self.cli = self.exe.parent / 'resources' / 'codex.exe'
        require(self.exe.is_file() and self.cli.is_file(), 'RUNTIME_MISSING')
        receipt = json.loads(read_private(self.exe.parent / 'codex-labels-build.json', 2 * MAX_AUTH))
        require(receipt.get('version') == 3 and Path(receipt.get('configPath', '')).resolve() == self.root / 'labels.json', 'RUNTIME_MISMATCH')
        self.parent = None; self.profile_id = profile_id; self.tracked = {}; self.helper_pids = {os.getpid()}
        # PyInstaller's one-file bootloader can be a separate surviving parent.
        for ancestor in psutil.Process().parents():
            if ancestor.pid == parent_pid: break
            if Path(ancestor.exe()).name.lower() == 'codexlabelshelper.exe': self.helper_pids.add(ancestor.pid)
        if parent_pid:
            try:
                p = psutil.Process(parent_pid)
                require(Path(p.exe()).resolve() == self.exe.resolve(), 'PARENT_MISMATCH')
                self.parent = (p.pid, p.create_time())
            except psutil.Error: raise AccountError('PARENT_MISMATCH') from None
        if profile_id: require(PROFILE.fullmatch(profile_id), 'INVALID_PROFILE')
        require(not os.environ.get('CODEX_LABELS_SMOKE_DIRECTORY'), 'SMOKE_NOT_ALLOWED')
    def alive(self, pid, created):
        try:
            p = self.psutil.Process(pid)
            return p.create_time() == created and p.is_running()
        except self.psutil.NoSuchProcess: return False
        except self.psutil.Error: raise AccountError('PROCESS_CHECK_FAILED') from None
    def capture(self):
        if self.parent and self.alive(*self.parent):
            try:
                p = self.psutil.Process(self.parent[0]); self.tracked[p.pid] = p.create_time()
                for child in p.children(recursive=True):
                    if child.pid in self.helper_pids or any(a.pid in self.helper_pids for a in child.parents()): continue
                    self.tracked[child.pid] = child.create_time()
            except self.psutil.Error: raise AccountError('PROCESS_CHECK_FAILED') from None
    def close_and_wait(self):
        import sys
        self.capture()
        if self.parent and self.alive(*self.parent):
            require(sys.stdout is not None, 'PARENT_CHANNEL_CLOSED')
            # Exact public control line, consumed only by our fixed helper bridge.
            try: print('CODEX_LABELS_AUTO_ACCOUNT_QUIT', flush=True)
            except OSError: raise AccountError('PARENT_CHANNEL_CLOSED') from None
        end = time.monotonic() + 35
        while time.monotonic() < end:
            self.capture()
            if not any(self.alive(p, c) for p, c in self.tracked.items()):
                return
            time.sleep(0.15)
        raise AccountError('EXIT_NOT_CONFIRMED')
    def reopen(self):
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(('_PYI', 'PYINSTALLER_', 'ELECTRON_RUN_AS_NODE', 'CODEX_LABELS_BOUNDARY_')): env.pop(key, None)
        # Do not change the workspace or SQLite path. Explicit original home/profile.
        env['CODEX_HOME'] = str(self.home); env['CODEX_ELECTRON_USER_DATA_PATH'] = str(self.profile)
        env['CODEX_LABELS_LAUNCH_TOKEN'] = uuid.uuid4().hex
        args = [str(self.exe), '--user-data-dir=' + str(self.profile)]
        if self.profile_id:
            args.append('--codex-labels-account=' + self.profile_id)
            shared = Path(os.environ.get('LOCALAPPDATA', '')) / 'CodexLabels' / 'AccountWindows' / 'accounts'
            if self.home.parent.parent == shared.resolve():
                args.append('--codex-labels-account-protocol=1')
        child = subprocess.Popen(args, cwd=self.exe.parent, env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.7)
        require(child.poll() is None, 'REOPEN_FAILED')
        # PID alive is not proof that Desktop displays the verified account.


def main(argv=None):
    if argv == ['--probe']:
        print('CODEX_LABELS_AUTO_ACCOUNTS_V1', flush=True)
        return 0
    from automatic_accounts_ui import run
    return run(argv)
