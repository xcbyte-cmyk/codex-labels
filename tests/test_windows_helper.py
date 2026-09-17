"""Synthetic per-PC installation, rollback and launch contract tests."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch, Mock

from test_prepare_runtime import builder, write_archive
import windows_helper as helper


class WindowsHelperTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='labels-helper-')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base/'라벨 설치 폴더'
        self.source = self.base/'official/app'
        write_archive(self.source/'resources/app.asar', {
            'package.json': json.dumps({'version': builder.SUPPORTED_APP_VERSION}).encode(),
            '.vite/build/early-bootstrap.js': b'/* bootstrap */',
            '.vite/build/preload.js': b'/* preload */', 'unchanged.txt': b'original'})
        (self.source/'ChatGPT.exe').write_bytes(b'synthetic-executable-never-run')
        self.running = patch.object(helper, 'running_apps', return_value=[]).start()
        self.addCleanup(patch.stopall)

    def test_discovery_uses_registered_installation_on_nondefault_drive_path(self):
        with patch.object(helper, 'installed_sources', return_value=[self.source]):
            self.assertEqual(helper.find_source(), self.source.resolve())

    def test_unsupported_source_does_not_create_output(self):
        write_archive(self.source/'resources/app.asar', {'package.json': b'{"version":"new-version"}'})
        with patch.object(helper, 'installed_sources', return_value=[self.source]):
            with self.assertRaisesRegex(RuntimeError, '지원하는'):
                helper.find_source()
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            helper.prepare(self.root, self.source)
        self.assertFalse(self.root.exists())

    def test_first_install_is_ready_and_original_remains_unchanged(self):
        before = (self.source/'resources/app.asar').read_bytes()
        result = helper.prepare(self.root, self.source)
        self.assertTrue(result['ready'])
        self.assertEqual(helper.require_ready(self.root), self.root.resolve()/'runtime/app/ChatGPT.exe')
        self.assertEqual((self.source/'resources/app.asar').read_bytes(), before)
        self.assertFalse(helper.read_receipt(self.root)['liveAppActivated'])

    def test_update_preserves_personal_settings_and_keeps_backup(self):
        helper.prepare(self.root, self.source)
        self.mark_old_payload()
        labels, assignments = b'{"custom":"preserve"}', b'{"user":"preserve"}'
        (self.root/'labels.json').write_bytes(labels)
        (self.root/'assignments.json').write_bytes(assignments)
        result = helper.prepare(self.root, self.source)
        self.assertTrue(Path(result['backup']).is_dir())
        self.assertEqual((self.root/'labels.json').read_bytes(), labels)
        self.assertEqual((self.root/'assignments.json').read_bytes(), assignments)
        helper.require_ready(self.root)

    def test_failed_update_restores_previous_runtime_and_receipt(self):
        helper.prepare(self.root, self.source)
        before = (self.root/'runtime/app/resources/app.asar').read_bytes()
        self.mark_old_payload()
        with patch.object(builder, 'prepare_runtime', side_effect=OSError('copy failed')):
            with self.assertRaisesRegex(OSError, 'copy failed'):
                helper.prepare(self.root, self.source)
        self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(), before)
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'], 'old-payload')
        self.assertEqual(json.loads((self.root/'build-manifest.json').read_text(encoding='utf-8')), helper.read_receipt(self.root))

    def test_active_runtime_blocks_update_without_killing_process(self):
        helper.prepare(self.root, self.source)
        self.mark_old_payload()
        self.running.return_value = [(self.root/'runtime/app/ChatGPT.exe').resolve()]
        with self.assertRaisesRegex(RuntimeError, '창을 닫은'):
            helper.prepare(self.root, self.source)
        self.assertEqual(list((self.root/'runtime').glob('app.backup-*')), [])

    def test_moved_folder_and_new_payload_require_prepare(self):
        helper.prepare(self.root, self.source)
        moved = self.base/'다른 PC 경로'
        self.root.rename(moved)
        with self.assertRaisesRegex(RuntimeError, '폴더 위치'):
            helper.require_ready(moved)
        helper.prepare(moved, self.source)
        helper.require_ready(moved)
        with patch.object(helper, 'payload_fingerprint', return_value='new-version'):
            with self.assertRaisesRegex(RuntimeError, '새 버전'):
                helper.require_ready(moved)

    def test_foreign_runtime_and_source_overlap_are_rejected(self):
        (self.root/'runtime/app').mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, '빌드 기록'):
            helper.prepare(self.root, self.source)
        with self.assertRaisesRegex(RuntimeError, '공식 설치 폴더 밖'):
            helper.prepare(self.source, self.source)

    def test_low_disk_space_preserves_previous_runtime(self):
        helper.prepare(self.root, self.source)
        self.mark_old_payload()
        with patch.object(shutil, 'disk_usage', return_value=Mock(free=0)):
            with self.assertRaisesRegex(RuntimeError, '공간이 부족'):
                helper.prepare(self.root, self.source)
        self.assertTrue((self.root/'runtime/app/ChatGPT.exe').is_file())

    def mark_old_payload(self):
        receipt = helper.read_receipt(self.root)
        receipt['helperPayloadSha256'] = 'old-payload'
        helper.write_json(self.root/'runtime/app/codex-labels-build.json', receipt)

    def test_repeat_install_reuses_current_runtime_without_creating_backup(self):
        helper.prepare(self.root, self.source)
        with patch.object(builder, 'prepare_runtime') as build:
            self.assertTrue(helper.prepare(self.root, self.source)['alreadyPrepared'])
            build.assert_not_called()
        self.assertEqual(list((self.root/'runtime').glob('app.backup-*')), [])

    def test_launch_uses_profile_env_without_touching_codex_home_or_registering(self):
        helper.prepare(self.root, self.source)
        profile = self.base/'profile'
        with patch.object(helper, 'profile_path', return_value=profile), \
                patch.dict(helper.os.environ, {'ELECTRON_RUN_AS_NODE': '1', 'CODEX_HOME': 'existing-home'}), \
                patch.object(helper.subprocess, 'Popen', return_value=Mock(pid=123)) as spawn:
            status = helper.launch(self.root)
        args, kwargs = spawn.call_args
        self.assertEqual(args[0], [str(self.root.resolve()/'runtime/app/ChatGPT.exe'), '--user-data-dir=' + str(profile)])
        self.assertEqual(kwargs['env']['CODEX_HOME'], 'existing-home')
        self.assertNotIn('ELECTRON_RUN_AS_NODE', kwargs['env'])
        self.assertEqual(kwargs['env']['CODEX_ELECTRON_USER_DATA_PATH'], str(profile))
        self.assertEqual(status['status'], 'launch-requested')

    def test_next_launch_applies_new_payload_and_preserves_personal_files(self):
        helper.prepare(self.root,self.source)
        self.mark_old_payload()
        config=(self.root/'labels.json').read_bytes()
        assignments=(self.root/'assignments.json').read_bytes()
        with patch.object(helper,'find_source',return_value=self.source), \
                patch.object(helper,'profile_path',return_value=self.base/'profile'), \
                patch.object(helper.subprocess,'Popen',return_value=Mock(pid=123)) as spawn:
            helper.launch(self.root)
        spawn.assert_called_once()
        self.assertEqual((self.root/'labels.json').read_bytes(),config)
        self.assertEqual((self.root/'assignments.json').read_bytes(),assignments)
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'],helper.payload_fingerprint())

    def test_launch_never_updates_or_kills_a_running_old_runtime(self):
        helper.prepare(self.root,self.source);self.mark_old_payload()
        self.running.return_value=[(self.root/'runtime/app/ChatGPT.exe').resolve()]
        with patch.object(helper,'find_source',return_value=self.source), patch.object(helper.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError,'창을 닫은'): helper.launch(self.root)
        spawn.assert_not_called()
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'],'old-payload')

    def test_other_labels_copy_cannot_silently_receive_new_launch(self):
        helper.prepare(self.root, self.source)
        self.running.return_value = [self.base/'another/runtime/app/ChatGPT.exe']
        with patch.object(helper.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, '다른 폴더'):
                helper.launch(self.root)
            spawn.assert_not_called()

    @unittest.skipUnless(helper.sys.platform == 'win32', 'Windows mutex')
    def test_preparation_mutex_rejects_concurrent_build_and_releases(self):
        with helper.preparation_lock(self.root):
            with self.assertRaisesRegex(RuntimeError, '이미 진행'):
                with helper.preparation_lock(self.root):
                    pass
        with helper.preparation_lock(self.root):
            pass


if __name__ == '__main__':
    unittest.main()
