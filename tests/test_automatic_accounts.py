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
from automatic_accounts import (AccountError, Credential, Handoff, Vault, NativeVerifier,
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
    def __init__(self, log): self.log = log; self.fail = None; self.home = None
    def require_file_store(self, home):
        self.log.append('store-check')
        if self.fail == 'store': raise AccountError('FILE_STORE_REQUIRED')
    def prepared(self, value):
        self.log.append('prepare-target')
        if self.fail == 'prepare': raise AccountError('LOGIN_REQUIRED')
        return credential(value.identity[0], 2)
    def active(self, home, expected):
        self.log.append('verify-active')
        if self.fail == 'verify': raise AccountError('IDENTITY_MISMATCH')
        if self.fail == 'foreign':
            atomic_write(home / 'auth.json', credential('C').raw)
            raise AccountError('IDENTITY_MISMATCH')
        current = Credential.parse(read_private(home / 'auth.json'))
        assert current.identity == expected
        newer = credential(current.identity[0], 3)
        atomic_write(home / 'auth.json', newer.raw)
        return newer

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
        self.log = []; self.verifier = FakeVerifier(self.log); self.desktop = FakeDesktop(self.log)
        self.h = Handoff(self.home, self.vault, self.verifier, self.desktop)
    def tearDown(self): self.temp.cleanup()
    def switch(self): return self.h.switch(self.bid, consent=True, work_saved=True)
    def test_selection_performs_actual_file_handoff_and_relaunch(self):
        result = self.switch()
        self.assertTrue(result['changed']); self.assertFalse(result['desktopIdentityObserved'])
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, self.b.identity)
        self.assertLess(self.log.index('exit'), self.log.index('verify-active'))
        self.assertLess(self.log.index('verify-active'), self.log.index('reopen'))
        self.assertFalse(self.vault.journal.exists())
    def test_entire_history_config_and_workspace_path_unchanged(self):
        for i in range(600): (self.home / 'sessions' / f'{i}.jsonl').write_text(f'conversation {i}')
        before = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob('*') if p.is_file() and p.name != 'auth.json'}
        self.switch()
        after = {p.relative_to(self.home): p.read_bytes() for p in self.home.rglob('*') if p.is_file() and p.name != 'auth.json'}
        self.assertEqual(before, after)
    def test_refresh_tokens_written_back_to_selected_registry(self):
        self.switch(); _, value = self.vault.get(self.bid)
        self.assertEqual(value.raw, credential('B', 3).raw)
    def test_latest_source_refresh_saved_after_exit(self):
        self.desktop.on_close = lambda: atomic_write(self.home / 'auth.json', credential('A', 5).raw)
        self.switch(); _, value = self.vault.get(self.aid)
        self.assertEqual(value.raw, credential('A', 5).raw)
    def test_source_account_changed_during_shutdown_not_overwritten(self):
        self.desktop.on_close = lambda: atomic_write(self.home / 'auth.json', credential('C').raw)
        with self.assertRaisesRegex(AccountError, 'AUTH_CHANGED_EXTERNALLY'): self.switch()
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, credential('C').identity)
    def test_no_consent_no_actions(self):
        with self.assertRaisesRegex(AccountError, 'CONSENT_REQUIRED'): self.h.switch(self.bid)
        self.assertEqual(self.log, [])
    def test_missing_saved_work_confirmation(self):
        with self.assertRaisesRegex(AccountError, 'CONSENT_REQUIRED'): self.h.switch(self.bid, consent=True)
    def test_other_app_never_stopped_or_modified(self):
        self.desktop.busy = True
        with self.assertRaisesRegex(AccountError, 'OTHER_CODEX_RUNNING'): self.switch()
        self.assertNotIn('exit', self.log); self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
    def test_failed_exit_no_auth_change(self):
        self.desktop.exit_fails = True
        with self.assertRaisesRegex(AccountError, 'EXIT_NOT_CONFIRMED'): self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw); self.assertFalse(self.vault.journal.exists())
    def test_keyring_or_unknown_config_never_converted(self):
        self.verifier.fail = 'store'
        with self.assertRaisesRegex(AccountError, 'FILE_STORE_REQUIRED'): self.switch()
        self.assertNotIn('exit', self.log); self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
    def test_target_auth_failure_before_exit(self):
        self.verifier.fail = 'prepare'
        with self.assertRaisesRegex(AccountError, 'LOGIN_REQUIRED'): self.switch()
        self.assertNotIn('exit', self.log)
    def test_target_verification_failure_rolls_back_no_model_replay(self):
        self.verifier.fail = 'verify'
        with self.assertRaisesRegex(AccountError, 'IDENTITY_MISMATCH'): self.switch()
        self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
        self.assertNotIn('reopen', self.log); self.assertFalse(self.vault.journal.exists())
    def test_unrelated_new_login_not_overwritten_during_rollback(self):
        self.verifier.fail = 'foreign'
        with self.assertRaisesRegex(AccountError, 'RECOVERY_REQUIRED'): self.switch()
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, credential('C').identity)
        self.assertTrue(self.vault.journal.exists())
    def test_crash_marker_blocks_another_switch(self):
        self.vault.begin(self.a, self.b)
        with self.assertRaisesRegex(AccountError, 'RECOVERY_REQUIRED'): self.switch()
    def test_pending_credential_recovery_is_explicit_and_reopens(self):
        self.vault.begin(self.a, self.b); atomic_write(self.home / 'auth.json', self.b.raw)
        result = self.h.recover()
        self.assertEqual(result['state'], 'source-restored'); self.assertIn('reopen', self.log)
    def test_cancel_after_preverification_preserves_source(self):
        with self.assertRaisesRegex(AccountError, 'CANCELLED'):
            self.h.switch(self.bid, consent=True, work_saved=True, cancelled=lambda: True)
        self.assertNotIn('exit', self.log); self.assertEqual(read_private(self.home / 'auth.json'), self.a.raw)
    def test_relaunch_failure_does_not_undo_verified_account(self):
        self.desktop.launch_fails = True
        with self.assertRaisesRegex(AccountError, 'REOPEN_FAILED'): self.switch()
        self.assertEqual(Credential.parse(read_private(self.home / 'auth.json')).identity, self.b.identity)
    def test_same_account_does_not_logout(self):
        self.assertFalse(self.h.switch(self.aid, consent=True, work_saved=True)['changed'])
        self.assertEqual(self.log, [])
    def test_unknown_profile_does_not_touch_current(self):
        with self.assertRaisesRegex(AccountError, 'PROFILE_NOT_FOUND'):
            self.h.switch('f' * 32, consent=True, work_saved=True)
        self.assertEqual(self.log, [])
    def test_corrupt_vault_not_recreated_empty(self):
        self.vault.file.write_bytes(b'broken')
        with self.assertRaisesRegex(AccountError, 'VAULT_UNAVAILABLE'): self.vault.list()
        self.assertEqual(self.vault.file.read_bytes(), b'broken')
    def test_vault_only_exposes_display_metadata(self):
        public = json.dumps(self.vault.list())
        for secret in ('refresh_token', 'access_token', 'SYNTHETIC', 'fixture.'): self.assertNotIn(secret, public)
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
