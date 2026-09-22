"""Synthetic credentials only. No network, real account files, or Windows app."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from automatic_accounts import (AccountError, Credential, Handoff, Vault,
    NativeRpc, DPAPI, atomic_write, read_private, clean_environment, WindowsDesktop)

def jwt(account='A', user='uA', stamp=1):
    body = {'sub': user, 'email': user + '@example.invalid', 'exp': 4102444800,
            'https://api.openai.com/auth': {'chatgpt_account_id': account, 'chatgpt_user_id': user}, 'stamp': stamp}
    part = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=')
    return 'fixture.' + part + '.not-a-signature'

def credential(account='A', stamp=1):
    t = jwt(account, 'u' + account, stamp)
    return Credential.parse(json.dumps({'auth_mode': 'chatgpt', 'tokens': {
        'access_token': t, 'id_token': t, 'refresh_token': 'SYNTHETIC-REFRESH-' + account + str(stamp),
        'account_id': account}}).encode())

class TestProtector:
    """Test substitute, deliberately NOT a production encryption implementation."""
    def seal(self, data): return b'TEST-ONLY:' + base64.b64encode(data)
    def open(self, data):
        if not data.startswith(b'TEST-ONLY:'): raise ValueError('invalid')
        return base64.b64decode(data[10:])

class FakeVerifier:
    def __init__(self, log): self.log = log
    def browser_login(self, **kwargs):
        raise AssertionError('Browser login must be explicitly stubbed in UI tests')

class FakeDesktop:
    def __init__(self, log): self.log = log; self.busy = False; self.exit_fails = False; self.launch_fails = False; self.on_close = None
    def preflight(self):
        self.log.append('preflight')
        if self.busy: raise AccountError('OTHER_CODEX_RUNNING')
    def assert_quiet(self):
        self.log.append('quiet')
        if self.busy: raise AccountError('OTHER_CODEX_RUNNING')
    def close_and_wait(self):
        self.log.append('exit')
        if self.exit_fails: raise AccountError('EXIT_NOT_CONFIRMED')
        if self.on_close: self.on_close()
    def reopen(self):
        self.log.append('reopen')
        if self.launch_fails: raise AccountError('REOPEN_FAILED')

class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.home = self.root / 'workspace'; self.home.mkdir()
        self.a, self.b = credential('A'), credential('B')
        atomic_write(self.home / 'auth.json', self.a.raw)
        (self.home / 'sessions').mkdir(); (self.home / 'sessions' / 'rollout.jsonl').write_text('original conversation\n')
        (self.home / 'config.toml').write_text('cli_auth_credentials_store="file"\n')
        self.vault = Vault(self.root / 'vault', TestProtector())
        self.aid = self.vault.save(self.a, 'A'); self.bid = self.vault.save(self.b, 'B')
        self.log = []; self.desktop = FakeDesktop(self.log)
        self.h = Handoff(self.home, self.vault, self.desktop)
    def tearDown(self): self.temp.cleanup()
    def switch(self): return self.h.switch(self.bid)
    def test_selection_performs_actual_file_handoff_and_relaunch(self):
        result = self.switch()
        self.assertTrue(result['changed']); self.assertFalse(result['desktopIdentityObserved'])
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, self.b.identity)
        self.assertEqual(self.log, ['exit', 'reopen'])
        self.assertFalse(self.vault.journal.exists())
    def test_entire_history_config_and_workspace_path_unchanged(self):
        for i in range(600): (self.home / 'sessions' / f'{i}.jsonl').write_text(f'conversation {i}')
        before = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob('*') if p.is_file() and p.name != 'auth.json'}
        self.switch()
        after = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob('*') if p.is_file() and p.name != 'auth.json'}
        self.assertEqual(before, after)
    def test_selected_cache_is_applied_without_online_refresh(self):
        self.switch(); _, value = self.vault.get(self.bid)
        self.assertEqual(value.raw, self.b.raw)
        self.assertEqual(read_private(self.home / 'auth.json'), self.b.raw)
    def test_latest_source_refresh_saved_after_exit(self):
        self.desktop.on_close = lambda: atomic_write(self.home / 'auth.json', credential('A', 5).raw)
        self.switch(); _, value = self.vault.get(self.aid)
        self.assertEqual(value.raw, credential('A', 5).raw)
    def test_source_account_changed_during_shutdown_is_saved_before_selection(self):
        self.desktop.on_close = lambda: atomic_write(self.home / 'auth.json', credential('C').raw)
        self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.b.raw)
        self.assertTrue(any(c.identity == credential('C').identity for _, c in self.vault._snapshot()))
    def test_switch_call_is_sufficient_without_consent_flags(self):
        self.assertTrue(self.h.switch(self.bid)['changed'])
    def test_other_app_does_not_block_switch(self):
        self.desktop.busy = True
        self.switch()
        self.assertEqual(self.log, ['exit', 'reopen'])
    def test_failed_exit_no_auth_change(self):
        self.desktop.exit_fails = True
        with self.assertRaisesRegex(AccountError, 'EXIT_NOT_CONFIRMED'): self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw); self.assertFalse(self.vault.journal.exists())
    def test_switch_does_not_call_online_verifier(self):
        with patch('automatic_accounts.NativeRpc', side_effect=AssertionError('unexpected RPC')):
            self.switch()
    def test_failed_auth_write_preserves_source(self):
        real_write = atomic_write
        def fail_selected(path, data):
            if path == self.home / 'auth.json': raise OSError('synthetic write failure')
            return real_write(path, data)
        with patch('automatic_accounts.atomic_write', side_effect=fail_selected):
            with self.assertRaisesRegex(AccountError, 'HANDOFF_FAILED'): self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
        self.assertNotIn('reopen', self.log)
    def test_crash_marker_blocks_another_switch(self):
        self.vault.begin(self.a, self.b)
        with self.assertRaisesRegex(AccountError, 'RECOVERY_REQUIRED'): self.switch()
    def test_pending_credential_recovery_is_explicit_and_reopens(self):
        self.vault.begin(self.a, self.b); atomic_write(self.home / 'auth.json', self.b.raw)
        result = self.h.recover()
        self.assertEqual(result['state'], 'source-restored'); self.assertIn('reopen', self.log)
    def test_relaunch_failure_does_not_undo_verified_account(self):
        self.desktop.launch_fails = True
        with self.assertRaisesRegex(AccountError, 'REOPEN_FAILED'): self.switch()
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, self.b.identity)
    def test_same_account_does_not_logout(self):
        self.assertFalse(self.h.switch(self.aid)['changed'])
        self.assertEqual(self.log, [])
    def test_new_environment_can_select_its_first_account(self):
        (self.home / 'auth.json').unlink()
        self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.b.raw)
        self.assertEqual(self.log, ['exit', 'reopen'])
    def test_first_account_recovery_restores_logged_out_environment(self):
        self.vault.begin(None, self.b)
        atomic_write(self.home / 'auth.json', self.b.raw)
        self.h.recover()
        self.assertFalse((self.home / 'auth.json').exists())
        self.assertIn('reopen', self.log)
    def test_unknown_profile_does_not_touch_current(self):
        with self.assertRaisesRegex(AccountError, 'PROFILE_NOT_FOUND'):
            self.h.switch('f' * 32)
        self.assertEqual(self.log, [])
    def test_corrupt_vault_not_recreated_empty(self):
        self.vault.file.write_bytes(b'broken')
        with self.assertRaisesRegex(AccountError, 'VAULT_UNAVAILABLE'): self.vault.list()
        self.assertEqual(self.vault.file.read_bytes(), b'broken')
    def test_vault_only_exposes_display_metadata(self):
        public = json.dumps(self.vault.list())
        for secret in ('refresh_token', 'access_token', 'SYNTHETIC', 'fixture.'): self.assertNotIn(secret, public)
    def test_vault_operations_read_once_and_parse_each_account_once(self):
        for operation in (
            self.vault.list,
            lambda: self.vault.get(self.bid),
            lambda: self.vault.save(self.b, profile_id=self.bid),
            lambda: self.vault.remove(self.bid),
        ):
            with self.subTest(operation=operation), \
                    patch.object(self.vault.protector, 'open', wraps=self.vault.protector.open) as decrypt, \
                    patch.object(Credential, 'parse', wraps=Credential.parse) as parse:
                operation()
                self.assertEqual(decrypt.call_count, 1)
                self.assertEqual(parse.call_count, 2)
    def test_vault_reads_external_refresh_in_next_operation(self):
        self.vault.get(self.bid)
        other = Vault(self.vault.directory, TestProtector())
        fresh = credential('B', 12)
        other.save(fresh, profile_id=self.bid)
        self.assertEqual(self.vault.get(self.bid)[1].raw, fresh.raw)
    def test_bulk_import_decrypts_and_writes_once_then_is_read_only(self):
        candidates = [(credential('legacy-' + str(i)), '환경 ' + str(i)) for i in range(20)]
        with patch.object(self.vault.protector, 'open', wraps=self.vault.protector.open) as decrypt, \
                patch.object(self.vault.protector, 'seal', wraps=self.vault.protector.seal) as encrypt:
            result = self.vault.import_accounts(candidates)
            self.assertEqual(len(result), 22)
            self.assertEqual(decrypt.call_count, 1)
            self.assertEqual(encrypt.call_count, 1)
            decrypt.reset_mock(); encrypt.reset_mock()
            self.vault.import_accounts(candidates)
            self.assertEqual(decrypt.call_count, 1)
            encrypt.assert_not_called()
    def test_bulk_import_preserves_fresh_tokens_and_existing_names(self):
        fresh = credential('B', 99)
        self.vault.save(fresh, '갱신 계정 B', self.bid)
        self.vault.import_accounts([(self.b, '오래된 이름'), (self.b, '중복')])
        name, saved = self.vault.get(self.bid)
        self.assertEqual((name, saved.raw), ('갱신 계정 B', fresh.raw))
    def test_removed_registration_stays_removed_after_reopen_and_other_saves(self):
        self.vault.remove(self.bid)
        self.vault.save(credential('C'))
        reopened = Vault(self.vault.directory, TestProtector())
        reopened.import_accounts([(self.b, 'B')])
        self.assertNotIn(self.b.identity, {c.identity for _, c in reopened._snapshot()})
        self.assertIsNone(reopened.save(self.b, automatic=True))
        restored = reopened.save(self.b, '명시적 재등록')
        self.assertEqual(reopened.get(restored)[1].identity, self.b.identity)
    def test_switch_does_not_reregister_a_removed_source(self):
        self.vault.remove(self.aid)
        self.switch()
        self.assertNotIn(self.a.identity, {c.identity for _, c in self.vault._snapshot()})
    def test_legacy_registry_without_exclusion_metadata_is_readable(self):
        self.vault._save(self.vault.file, {'version': 1, 'accounts': self.vault.entries()})
        self.assertEqual(self.vault.get(self.aid)[1].raw, self.a.raw)
    def test_missing_delete_preserves_registry(self):
        original = self.vault.file.read_bytes()
        with self.assertRaisesRegex(AccountError, 'PROFILE_NOT_FOUND'):
            self.vault.remove('f' * 32)
        self.assertEqual(self.vault.file.read_bytes(), original)
    def test_dedup_import_never_overwrites_fresher_token(self):
        self.vault.save(credential('B', 9), profile_id=self.bid)
        self.vault.save(self.b, overwrite=False)
        self.assertEqual(self.vault.get(self.bid)[1].raw, credential('B', 9).raw)
    def test_registry_renewal_rejects_wrong_account(self):
        with self.assertRaisesRegex(AccountError, 'IDENTITY_MISMATCH'): self.vault.save(self.a, profile_id=self.bid)
    def test_delete_registration_keeps_current_auth_history(self):
        self.vault.remove(self.aid)
        self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
    @unittest.skipIf(os.name == 'nt', 'Symlink permission varies on Windows')
    def test_symlink_auth_refused(self):
        (self.home / 'auth.json').unlink(); (self.home / 'auth.json').symlink_to(self.vault.file)
        with self.assertRaisesRegex(AccountError, 'UNSAFE_PATH'): self.switch()
    def test_plaintext_production_dpapi_fallback_forbidden(self):
        if os.name == 'nt': self.skipTest('Windows-specific real DPAPI is opt-in')
        with self.assertRaisesRegex(AccountError, 'WINDOWS_REQUIRED'): DPAPI().seal(b'test')

class BoundaryTests(unittest.TestCase):
    def test_shared_environment_restart_preserves_account_protocol_and_home(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            desktop = object.__new__(WindowsDesktop)
            desktop.root = base / 'installation'
            desktop.exe = desktop.root / 'runtime' / 'app' / 'ChatGPT.exe'
            desktop.profile_id = 'a' * 32
            folder = base / 'CodexLabels' / 'AccountWindows' / 'accounts' / desktop.profile_id
            desktop.home, desktop.profile = folder / 'codex-home', folder / 'user-data'
            with patch.dict(os.environ, {'LOCALAPPDATA': str(base)}), \
                    patch('automatic_accounts.time.sleep'), \
                    patch('automatic_accounts.subprocess.Popen') as launch:
                launch.return_value.poll.return_value = None
                desktop.reopen()
            self.assertIn('--codex-labels-account-protocol=1', launch.call_args.args[0])
            self.assertEqual(launch.call_args.kwargs['env']['CODEX_HOME'], str(desktop.home))
            self.assertEqual(launch.call_args.kwargs['env']['CODEX_ELECTRON_USER_DATA_PATH'], str(desktop.profile))
    def test_environment_drops_other_account_routing(self):
        e = clean_environment({'PATH': 'x', 'CODEX_HOME': 'old', 'OPENAI_API_KEY': 'secret', 'CODEX_API_KEY': 'secret',
            'ELECTRON_RUN_AS_NODE': '1', '_PYI_HOME': 'x', 'NODE_OPTIONS': 'bad', 'SSL_CERT_FILE': 'ca'}, Path('/new'))
        self.assertEqual(e, {'PATH': 'x', 'SSL_CERT_FILE': 'ca', 'CODEX_HOME': str(Path('/new'))})
    def test_api_auth_not_imported(self):
        with self.assertRaises(AccountError): Credential.parse(b'{"OPENAI_API_KEY":"synthetic"}')
    def test_full_user_and_workspace_principal_checked(self):
        c = credential('B'); v = json.loads(c.raw); v['tokens']['account_id'] = 'A'
        with self.assertRaisesRegex(AccountError, 'IDENTITY_MISMATCH'): Credential.parse(json.dumps(v).encode())
    def test_single_native_probe_completes_real_pipe_handshake(self):
        # Independent Python server: production RPC/framing code is not reused.
        with tempfile.TemporaryDirectory() as d:
            p = Path(d); script = p / 'peer.py'
            script.write_text('''import sys,json
ready=False
for line in sys.stdin:
 m=json.loads(line)
 if m.get("method")=="initialized": ready=True; continue
 if m.get("method")=="initialize": result={"userAgent":"independent-fixture"}
 elif ready and m.get("method")=="config/read": result={"config":{"cli_auth_credentials_store":"file"}}
 else:
  print(json.dumps({"id":m["id"],"error":{"code":-32000,"message":"FIXTURE-SECRET-MUST-NOT-LEAK"}}),flush=True);continue
 print(json.dumps({"id":m["id"],"result":result}),flush=True)
''')
            def popen(_args, **kw): return subprocess.Popen([sys.executable, str(script)], **kw)
            rpc = NativeRpc(Path('unused'), p, popen=popen)
            try:
                self.assertEqual(rpc.call('config/read')['config']['cli_auth_credentials_store'], 'file')
                with self.assertRaisesRegex(AccountError, '^NATIVE_REQUEST_FAILED$'): rpc.call('bad/method')
            finally: rpc.close()
            self.assertIsNotNone(rpc.child.returncode)
    def test_native_verifier_never_requests_model_or_logout(self):
        source = Path(__file__).resolve().parents[1] / 'automatic_accounts.py'
        text = source.read_text()
        for method in ("call('turn/start'", "call('account/logout'", "call('command/exec'"): self.assertNotIn(method, text)

if __name__ == '__main__': unittest.main()
