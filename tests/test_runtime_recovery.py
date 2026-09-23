"""Rollback boundaries; disposable files only, never a real user profile."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
from test_prepare_runtime import builder, write_archive, read_archive
import windows_helper as helper
import runtime_recovery as recovery


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='labels-recovery-')
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base/'labels'; self.source = self.base/'official/app'
        write_archive(self.source/'resources/app.asar', {
            'package.json': json.dumps({'version': builder.VERIFIED_APP_VERSION}).encode(),
            '.vite/build/early-bootstrap.js': b'/* original bootstrap */',
            '.vite/build/preload.js': b'/* original preload */', 'original.txt': b'unchanged'})
        (self.source/'ChatGPT.exe').write_bytes(b'fake-not-executed')
        p = patch.object(helper, 'running_apps', return_value=[]); p.start(); self.addCleanup(p.stop)
        # Never discover the real Store installation from tests.
        p = patch.object(helper, 'installed_sources', return_value=[self.source]); p.start(); self.addCleanup(p.stop)
        helper.prepare(self.root, self.source)
        receipt = helper.read_receipt(self.root)
        receipt.update(helperPayloadSha256='previous-payload', helperVersion='0.2.1')
        helper.write_json(self.root/'runtime/app/codex-labels-build.json', receipt)
        tools = self.root/'.updates/stage-old/previous'; tools.mkdir(parents=True)
        (tools/'CodexLabelsHelper.exe').write_bytes(b'MZ-previous-helper')
        (tools/'build-info.json').write_text('{"version":"0.2.1"}', encoding='utf-8')
        (self.root/'CodexLabelsHelper.exe').write_bytes(b'MZ-new-helper')
        (self.root/'build-info.json').write_text('{"version":"0.2.3"}', encoding='utf-8')
        self.personal = {name: (self.root/name).read_bytes() for name in ('labels.json', 'assignments.json')}

    def assert_personal_unchanged(self):
        for name, data in self.personal.items():
            self.assertEqual((self.root/name).read_bytes(), data)

    def test_refresh_uses_current_base_without_official_source_and_can_roll_back_pair(self):
        before = read_archive(self.root/'runtime/app/resources/app.asar')
        self.source.rename(self.source.with_name('unavailable'))
        result = helper.prepare(self.root)
        self.assertTrue(result['backup'])
        after = read_archive(self.root/'runtime/app/resources/app.asar')
        for name in ('original.txt', 'package.json', '.vite/build/early-bootstrap.js'):
            self.assertEqual(before[name][0], after[name][0])
        self.assertTrue(helper.read_receipt(self.root)['basePreserved'])
        recovery.complete(self.root)
        self.assertTrue(helper.update_status(self.root)['rollbackAvailable'])
        recovery.restore(self.root, helper.valid_runtime, helper.running_apps)
        self.assertEqual(helper.read_receipt(self.root)['helperVersion'], '0.2.1')
        self.assertEqual((self.root/'CodexLabelsHelper.exe').read_bytes(), b'MZ-previous-helper')
        self.assertFalse(helper.update_status(self.root)['pendingRestart'])
        self.assert_personal_unchanged()

    def test_failed_preparation_restores_tools_and_does_not_retry_on_next_launch(self):
        recovery.checkpoint(self.root, None, helper.read_receipt(self.root), helper.payload_fingerprint())
        recovery.failed(self.root, 'synthetic preparation failure', helper.payload_fingerprint())
        recovery.restore(self.root, helper.valid_runtime, helper.running_apps)
        with patch.object(helper, 'prepare') as prepare, patch.object(helper.subprocess, 'Popen', return_value=Mock(pid=12)):
            helper.launch(self.root)
            prepare.assert_not_called()
        self.assert_personal_unchanged()

    def test_failed_new_start_schedules_restore_and_pair_is_recoverable(self):
        process = Mock(pid=12); process.poll.return_value = 1
        with patch.object(helper.subprocess, 'Popen', return_value=process), \
                patch.object(helper, 'wait_until_active', side_effect=RuntimeError('candidate exited')), \
                patch.object(recovery, 'schedule', return_value={'recoveryScheduled': True}) as schedule:
            self.assertTrue(helper.launch(self.root, wait_ready=True)['recoveryScheduled'])
            schedule.assert_called_once()
        recovery.restore(self.root, helper.valid_runtime, helper.running_apps)
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'], 'previous-payload')
        self.assert_personal_unchanged()

    def test_unknown_existing_patch_is_rejected_without_touching_current(self):
        archive = self.root/'runtime/app/resources/app.asar'
        files = {name: data for name, (data, _) in read_archive(archive).items()}
        files['.vite/build/early-bootstrap.js'] = b'unknown modification'
        write_archive(archive, files)
        receipt = helper.read_receipt(self.root); receipt['patchedAsarSha256'] = builder.file_hash(archive)
        helper.write_json(self.root/'runtime/app/codex-labels-build.json', receipt)
        before = archive.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'Unknown existing'):
            helper.prepare(self.root)
        self.assertEqual(archive.read_bytes(), before)
        self.assert_personal_unchanged()

    def test_modified_backup_tool_is_rejected_before_runtime_switch(self):
        helper.prepare(self.root)
        current = helper.read_receipt(self.root)
        (self.root/'.updates/stage-old/previous/CodexLabelsHelper.exe').write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, '변경'):
            recovery.restore(self.root, helper.valid_runtime, helper.running_apps)
        self.assertEqual(helper.read_receipt(self.root), current)

    def test_isolated_smoke_has_separate_home_profile_config_and_quits(self):
        original = dict(self.personal)
        def spawn(_args, **kwargs):
            env = kwargs['env']
            config = Path(env['CODEX_LABELS_SMOKE_DIRECTORY'])
            self.assertNotEqual(config, self.root)
            self.assertTrue(Path(env['CODEX_HOME']).is_relative_to(config.parent))
            self.assertTrue(Path(env['CODEX_ELECTRON_USER_DATA_PATH']).is_relative_to(config.parent))
            (config/'runtime-status.json').write_text(json.dumps({'status': 'stopped', 'settingsAvailable': True,
                'smokePassed': True, 'launchToken': env['CODEX_LABELS_LAUNCH_TOKEN']}), encoding='utf-8')
            return Mock(wait=Mock(return_value=0), poll=Mock(return_value=0))
        with patch.object(recovery.subprocess, 'Popen', side_effect=spawn):
            recovery.smoke(self.root/'runtime/app', helper.ASSETS/'labels.example.json')
        self.assertEqual(self.personal, original)
        self.assert_personal_unchanged()


if __name__ == '__main__':
    unittest.main()
