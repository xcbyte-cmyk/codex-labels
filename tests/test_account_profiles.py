import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

from test_prepare_runtime import builder
import account_profiles as profiles
import windows_helper as helper


class AccountProfilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_separate_homes_profiles_and_credentials_are_not_copied(self):
        a, b = profiles.create(self.root, '회사 A'), profiles.create(self.root, '개인 B')
        inherited = {'PATH': 'keep', 'CODEX_HOME': 'old', 'CODEX_SQLITE_HOME': 'shared',
                     'CODEX_APP_SERVER_WS_URL': 'ws://old', 'CODEX_APP_SERVER_FORCE_CLI': '1',
                     'CODEX_ACCESS_TOKEN': 'secret',
                     'OPENAI_API_KEY': 'secret', 'ELECTRON_RUN_AS_NODE': '1', '_PYI_HOME': 'temp'}
        _, da, pa, ea = profiles.launch_context(self.root, a['id'], inherited)
        _, db, pb, eb = profiles.launch_context(self.root, b['id'], inherited)
        self.assertNotEqual(pa, pb); self.assertNotEqual(ea['CODEX_HOME'], eb['CODEX_HOME'])
        self.assertEqual(ea['PATH'], 'keep')
        for key in ('CODEX_APP_SERVER_WS_URL', 'CODEX_APP_SERVER_FORCE_CLI', 'CODEX_ACCESS_TOKEN',
                    'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', '_PYI_HOME'):
            self.assertNotIn(key, ea)
        self.assertFalse((da/'codex-home/auth.json').exists())
        (da/'codex-home/auth.json').write_text('private A')
        profiles.launch_context(self.root, b['id'], inherited)
        self.assertFalse((db/'codex-home/auth.json').exists())
        self.assertEqual((da/'codex-home/auth.json').read_text(), 'private A')
        self.assertIn('forced_login_method = "chatgpt"', (db/'codex-home/config.toml').read_text())

    def test_ids_and_metadata_fail_closed(self):
        for value in ('../default', '', None, 'a'*31, 'A'*32):
            with self.assertRaises(ValueError): profiles.account_path(self.root, value)
        a = profiles.create(self.root, '회사')
        with self.assertRaises(ValueError): profiles.create(self.root, '회사')
        with self.assertRaises(ValueError): profiles.create(self.root, '\n')
        p = profiles.account_path(self.root, a['id'])/'account.json'
        p.write_text('{"version": 2}', encoding='utf-8')
        with self.assertRaises(ValueError): profiles.read(self.root, a['id'])

    def test_launch_uses_scoped_readiness_and_never_default_launch(self):
        a = profiles.create(self.root, '회사 A')
        exe = self.root/'runtime/app/ChatGPT.exe'
        process = Mock(pid=4321)
        from contextlib import nullcontext
        with patch.object(helper, 'preparation_lock', return_value=nullcontext()), \
             patch.object(helper, 'require_ready', return_value=exe), \
             patch.object(helper.subprocess, 'Popen', return_value=process) as spawn, \
             patch.object(helper, 'wait_until_active', return_value={'processId': 1234}) as ready:
            result = helper.launch_account(self.root, a['id'])
        self.assertEqual(result['processId'], 1234)
        self.assertIn('--codex-labels-account=' + a['id'], spawn.call_args.args[0])
        self.assertEqual(ready.call_args.kwargs['account_id'], a['id'])
        self.assertEqual(ready.call_args.kwargs['status_directory'], self.root/'accounts'/a['id'])
        self.assertFalse((self.root/'launch-status.json').exists())
        self.assertTrue((self.root/'accounts'/a['id']/'labels.json').exists())

    def test_wrong_account_readiness_is_rejected(self):
        from datetime import datetime, timezone
        directory = self.root/'accounts'; directory.mkdir()
        (directory/'runtime-status.json').write_text(json.dumps({'status': 'active',
            'launchToken': 'token', 'accountProfileId': 'wrong', 'processId': 1,
            'updatedAt': datetime.now(timezone.utc).isoformat(),
            'executable': str(self.root/'runtime/app/ChatGPT.exe')}))
        process = Mock(labels_launch_token='token', pid=1); process.poll.return_value = None
        with self.assertRaisesRegex(RuntimeError, '준비 완료'):
            helper.wait_until_active(self.root, process, 0, timeout=0.01,
                                    status_directory=directory, account_id='expected')


if __name__ == '__main__': unittest.main()
