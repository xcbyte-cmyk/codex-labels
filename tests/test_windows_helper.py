"""Synthetic per-PC installation, rollback and launch contract tests."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch, Mock

from test_prepare_runtime import builder, write_archive
import windows_helper as helper
from package_windows import PAYLOAD


class WindowsHelperTests(unittest.TestCase):
    def test_legacy_account_entry_opens_unified_desktop_picker(self):
        import account_manager
        with patch.object(helper.account_profiles, 'shared_root', return_value=self.base/'shared'), \
                patch.object(account_manager, 'run', return_value=0) as manager, \
                patch.object(helper, 'launch_account', return_value={'status': 'active'}) as launch:
            self.assertEqual(helper.open_accounts(self.root), 0)
            options = manager.call_args.kwargs
            options['switch_account'](self.base/'shared', 'a'*32)
        launch.assert_called_once_with(self.root, 'a'*32, shared=True, open_account_picker=True)

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

    def test_payload_fingerprint_matches_packaged_files_only(self):
        digest = hashlib.sha256()
        for name in PAYLOAD:
            source = helper.ASSETS/name
            digest.update(source.name.encode())
            digest.update(source.read_bytes())
        self.assertEqual(helper.payload_fingerprint(), digest.hexdigest())

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

    def test_check_and_prepare_refresh_existing_runtime_after_official_upgrade(self):
        helper.prepare(self.root, self.source)
        write_archive(self.source/'resources/app.asar', {'package.json': b'{"version":"27.100.1"}'})
        with patch.object(helper, 'installed_sources', return_value=[self.source]), \
                patch('builtins.print') as output, \
                patch.object(helper.sys, 'argv', ['windows_helper.py', 'check', '--root', str(self.root)]):
            self.assertEqual(helper.main(), 0)
        checked = json.loads(output.call_args.args[0])
        self.assertTrue(checked['ready'])
        self.assertEqual(checked['source'], str(self.root.resolve()/'runtime/app'))

        self.mark_old_payload()
        with patch.object(helper, 'installed_sources', return_value=[self.source]), \
                patch('builtins.print') as output, \
                patch.object(helper.sys, 'argv', ['windows_helper.py', 'prepare', '--root', str(self.root), '--no-ui']):
            self.assertEqual(helper.main(), 0)
        prepared = json.loads(output.call_args.args[0])
        self.assertTrue(prepared['ready'])
        self.assertTrue(Path(prepared['backup']).is_dir())
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'], helper.payload_fingerprint())

    def test_explicit_source_is_not_replaced_by_existing_runtime(self):
        helper.prepare(self.root, self.source)
        write_archive(self.source/'resources/app.asar', {'package.json': b'{"version":"27.100.1"}'})
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            helper.preparation_source(self.root, self.source)

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
        previous_manifest=(self.root/'build-manifest.json').read_bytes()
        with patch.object(builder, 'prepare_runtime', side_effect=OSError('copy failed')):
            with self.assertRaisesRegex(OSError, 'copy failed'):
                helper.prepare(self.root, self.source)
        self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(), before)
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'], 'old-payload')
        self.assertEqual((self.root/'build-manifest.json').read_bytes(), previous_manifest)

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
                patch.dict(helper.os.environ, {'ELECTRON_RUN_AS_NODE': '1', 'CODEX_HOME': 'existing-home', '_PYI_APPLICATION_HOME_DIR':'deleted-extraction', '_PYI_PARENT_PROCESS_LEVEL':'1'}), \
                patch.object(helper.subprocess, 'Popen', return_value=Mock(pid=123)) as spawn:
            status = helper.launch(self.root)
        args, kwargs = spawn.call_args
        self.assertEqual(args[0][:2], [str(self.root.resolve()/'runtime/app/ChatGPT.exe'), '--user-data-dir=' + str(profile)])
        self.assertEqual(args[0][2], '--codex-labels-launch-token='+kwargs['env']['CODEX_LABELS_LAUNCH_TOKEN'])
        self.assertEqual(kwargs['env']['CODEX_HOME'], 'existing-home')
        self.assertNotIn('ELECTRON_RUN_AS_NODE', kwargs['env'])
        self.assertFalse(any(name.startswith('_PYI_') for name in kwargs['env']))
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
            with self.assertRaisesRegex(RuntimeError,'설치하고 다시 실행'): helper.launch(self.root)
        spawn.assert_not_called()
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'],'old-payload')

    def test_other_labels_copy_cannot_silently_receive_new_launch(self):
        helper.prepare(self.root, self.source)
        self.running.return_value = [self.base/'another/runtime/app/ChatGPT.exe']
        with patch.object(helper.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, '다른 폴더'):
                helper.launch(self.root)
        spawn.assert_not_called()

    def test_update_keeps_current_app_during_build_and_interruption(self):
        helper.prepare(self.root,self.source);self.mark_old_payload()
        old=(self.root/'runtime/app/resources/app.asar').read_bytes()
        def interrupted(*args,**kwargs):
            self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(),old)
            self.assertNotEqual(kwargs['destination'],self.root/'runtime/app')
            raise KeyboardInterrupt()
        with patch.object(builder,'prepare_runtime',side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):helper.prepare(self.root,self.source)
        self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(),old)

    def test_app_reopened_during_build_prevents_final_replacement(self):
        helper.prepare(self.root,self.source);self.mark_old_payload()
        old=(self.root/'runtime/app/resources/app.asar').read_bytes()
        self.running.side_effect=[[],[(self.root/'runtime/app/ChatGPT.exe').resolve()]]
        with self.assertRaisesRegex(RuntimeError,'다시 열렸'):
            helper.prepare(self.root,self.source)
        self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(),old)

    def test_canceled_restart_never_opens_or_waits_for_parent(self):
        root=self.root.resolve();token='a'*32
        (root/'.restarts').mkdir(parents=True)
        (root/'.restarts'/(token+'.cancel')).write_text('cancelled')
        self.assertFalse(helper.wait_for_parent(123,root,token,lambda *_:None))

    def test_interrupted_publish_recovers_valid_backup_but_not_foreign_config(self):
        helper.prepare(self.root,self.source)
        backup=self.root/'runtime/app.backup-20260101-test'
        (self.root/'runtime/app').rename(backup)
        helper.recover_runtime(self.root)
        self.assertTrue((self.root/'runtime/app/ChatGPT.exe').is_file())
        (self.root/'runtime/app').rename(backup)
        receipt=json.loads((backup/'codex-labels-build.json').read_text(encoding='utf-8'))
        receipt['configPath']=str(self.base/'foreign/labels.json')
        (backup/'codex-labels-build.json').write_text(json.dumps(receipt),encoding='utf-8')
        helper.recover_runtime(self.root)
        self.assertFalse((self.root/'runtime/app').exists())

    def test_failed_update_launches_verified_previous_runtime(self):
        helper.prepare(self.root,self.source);self.mark_old_payload()
        with patch.object(helper,'prepare',side_effect=RuntimeError('candidate failed')), \
                patch.object(helper,'profile_path',return_value=self.base/'profile'), \
                patch.object(helper.subprocess,'Popen',return_value=Mock(pid=123)) as spawn:
            result=helper.launch(self.root)
        spawn.assert_called_once()
        self.assertEqual(result['status'],'launch-requested')
        self.assertEqual(helper.read_receipt(self.root)['helperPayloadSha256'],'old-payload')

    def test_first_launch_installs_then_opens_with_one_call(self):
        with patch.object(helper,'find_source',return_value=self.source), \
                patch.object(helper,'profile_path',return_value=self.base/'profile'), \
                patch.object(helper.subprocess,'Popen',return_value=Mock(pid=123)) as spawn:
            helper.launch(self.root)
        spawn.assert_called_once();helper.require_ready(self.root)

    def test_readiness_requires_fresh_launch_identity_and_detects_early_exit(self):
        from datetime import datetime,timezone
        helper.prepare(self.root,self.source)
        process=Mock(pid=123,labels_launch_token='new-token');process.poll.return_value=1
        status={'status':'active','processId':123,'launchToken':'old-token','updatedAt':datetime.now(timezone.utc).isoformat(),
                'executable':str(self.root.resolve()/'runtime/app/ChatGPT.exe')}
        helper.write_json(self.root/'runtime-status.json',status)
        with self.assertRaisesRegex(RuntimeError,'준비되기 전에'):
            helper.wait_until_active(self.root.resolve(),process,0,timeout=1)
        status['launchToken']='new-token';helper.write_json(self.root/'runtime-status.json',status)
        self.assertEqual(helper.wait_until_active(self.root.resolve(),process,0,timeout=1)['processId'],123)

    def test_local_status_separates_installed_and_downloaded_versions(self):
        helper.prepare(self.root,self.source);self.mark_old_payload()
        receipt=helper.read_receipt(self.root);receipt['helperVersion']='0.1.0'
        helper.write_json(self.root/'runtime/app/codex-labels-build.json',receipt)
        state=helper.update_status(self.root)
        self.assertEqual(state['currentVersion'],'0.1.0')
        self.assertEqual(state['downloadedVersion'],helper.VERSION)
        self.assertTrue(state['pendingRestart'])

    def test_original_codex_version_notice_reads_newer_unsupported_install_without_patching(self):
        helper.prepare(self.root,self.source)
        original=(self.root/'runtime/app/resources/app.asar').read_bytes()
        config=(self.root/'labels.json').read_bytes()
        assignments=(self.root/'assignments.json').read_bytes()
        with patch.object(helper,'installed_sources',return_value=[self.source]):
            self.assertEqual(helper.codex_status(self.root)['state'],'same')
            write_archive(self.source/'resources/app.asar',{'package.json':b'{"version":"27.100.1"}'})
            state=helper.codex_status(self.root)
        self.assertEqual(state,{'state':'changed','baseVersion':builder.SUPPORTED_APP_VERSION,'installedVersion':'27.100.1','newer':True})
        self.assertEqual((self.root/'runtime/app/resources/app.asar').read_bytes(),original)
        self.assertEqual((self.root/'labels.json').read_bytes(),config)
        self.assertEqual((self.root/'assignments.json').read_bytes(),assignments)

    def test_original_codex_notice_supports_old_receipts_and_graceful_read_failure(self):
        helper.prepare(self.root,self.source)
        receipt=helper.read_receipt(self.root);receipt.pop('sourceAppVersion',None)
        helper.write_json(self.root/'runtime/app/codex-labels-build.json',receipt)
        with patch.object(helper,'installed_sources',return_value=[self.source]):
            self.assertEqual(helper.codex_status(self.root)['baseVersion'],builder.SUPPORTED_APP_VERSION)
        with patch.object(helper,'installed_sources',side_effect=RuntimeError('unavailable')):
            self.assertEqual(helper.codex_status(self.root)['state'],'unavailable')

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
