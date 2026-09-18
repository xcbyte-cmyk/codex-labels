import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_prepare_runtime import builder
import account_profiles as profiles
import account_cleanup as cleanup


class AccountCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()/'install'
        self.account = profiles.create(self.root, '프로20')
        self.other = profiles.create(self.root, '계정 A')
        _, self.directory, _, _ = profiles.launch_context(self.root, self.account['id'], {})
        self.other_dir = profiles.account_path(self.root, self.other['id'])
        (self.directory/'codex-home/auth.json').write_text('test-token')
        (self.directory/'user-data/Cache').mkdir()
        (self.directory/'user-data/Cache/content').write_bytes(b'cache')
        (self.directory/'diagnostic.json').write_text('local')
        (self.other_dir/'keep.txt').write_bytes(b'other account')
        self.stop = Mock(return_value=3)

    def test_complete_delete_removes_all_profile_files_and_marker_without_backup(self):
        result = cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertTrue(result['deleted']); self.assertEqual(result['remainingFiles'], 0)
        self.assertFalse(result['backupCreated'])
        self.assertFalse(self.directory.exists())
        self.assertFalse(profiles.deletion_marker(self.root, self.account['id']).exists())
        self.assertEqual([p['id'] for p in profiles.list_accounts(self.root)], [self.other['id']])
        self.assertEqual((self.other_dir/'keep.txt').read_bytes(), b'other account')
        self.assertEqual(sorted(p.name for p in (self.root/'accounts').iterdir()), [self.other['id']])

    def test_stop_failure_is_visible_blocks_launch_and_retries(self):
        with self.assertRaisesRegex(RuntimeError, '삭제를 완료하지'):
            cleanup.delete_account(self.root, self.account['id'], stop=Mock(side_effect=RuntimeError('busy')))
        pending = next(p for p in profiles.list_accounts(self.root) if p['id'] == self.account['id'])
        self.assertTrue(pending['deleting'])
        self.assertEqual((self.directory/'codex-home/auth.json').read_text(), 'test-token')
        self.assertFalse((self.directory/'account.json').exists())
        with self.assertRaisesRegex(ValueError, '삭제가 완료되지'):
            profiles.launch_context(self.root, self.account['id'], {})
        cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertFalse(self.directory.exists())

    def test_partial_filesystem_failure_never_reports_success_and_retry_works(self):
        original = cleanup.shutil.rmtree
        def partially_remove(target, **kwargs):
            (self.directory/'diagnostic.json').unlink()
            raise PermissionError('locked cache')
        with patch.object(cleanup.shutil, 'rmtree', side_effect=partially_remove):
            with self.assertRaisesRegex(RuntimeError, '삭제 미완료'):
                cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertTrue(profiles.pending_deletion(self.root, self.account['id']))
        self.assertTrue((self.directory/'user-data/Cache/content').exists())
        cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertFalse(self.directory.exists())

    def test_marker_only_recovery_after_files_removed(self):
        marker = profiles.deletion_marker(self.root, self.account['id'])
        os.replace(self.directory/'account.json', marker)
        cleanup.shutil.rmtree(self.directory)
        self.assertTrue(any(p.get('deleting') for p in profiles.list_accounts(self.root)))
        cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertFalse(marker.exists())

    def test_invalid_ids_cannot_reach_other_paths_or_stop_processes(self):
        for value in ('..', '../accounts', '.', '', 'a'*31, None):
            with self.assertRaises(ValueError):
                cleanup.delete_account(self.root, value, stop=self.stop)
        self.stop.assert_not_called()
        self.assertTrue((self.other_dir/'keep.txt').exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows directory junction semantics')
    def test_nested_junction_removes_link_without_deleting_external_files(self):
        outside = Path(self.temp.name)/'external-project'; outside.mkdir()
        sentinel = outside/'source.txt'; sentinel.write_text('preserve')
        link = self.directory/'user-data/external-link'
        # Fixed test paths only. Creation uses cmd's junction builtin; deletion
        # remains entirely within the Python filesystem implementation.
        subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(link), str(outside)], check=True, capture_output=True)
        cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertEqual(sentinel.read_text(), 'preserve')
        self.assertFalse(self.directory.exists())

    @unittest.skipUnless(os.name == 'nt', 'Windows read-only files')
    def test_readonly_cache_is_removed(self):
        cache = self.directory/'user-data/Cache/content'
        cache.chmod(stat.S_IREAD)
        cleanup.delete_account(self.root, self.account['id'], stop=self.stop)
        self.assertFalse(self.directory.exists())

    def test_process_identity_uses_exact_scope_not_stale_pid_or_substring(self):
        process = Mock()
        process.exe.return_value = str(self.root/'runtime/app/ChatGPT.exe')
        process.cmdline.return_value = ['ChatGPT.exe', '--codex-labels-account='+self.other['id']]
        process.environ.return_value = {'CODEX_LABELS_ACCOUNT_ID': self.other['id'], 'CODEX_HOME': str(self.other_dir/'codex-home')}
        self.assertFalse(cleanup._owns_process(process, self.root, self.account['id'], self.directory))
        process.cmdline.return_value = ['ChatGPT.exe', '--codex-labels-account='+self.account['id']+'bad']
        self.assertFalse(cleanup._owns_process(process, self.root, self.account['id'], self.directory))
        process.cmdline.return_value = ['ChatGPT.exe', '--codex-labels-account='+self.account['id']]
        self.assertTrue(cleanup._owns_process(process, self.root, self.account['id'], self.directory))
        process.exe.return_value = str(Path(self.temp.name)/'unrelated.exe')
        self.assertFalse(cleanup._owns_process(process, self.root, self.account['id'], self.directory))

    def test_running_target_only_is_stopped_and_processes_are_rechecked(self):
        process = Mock(pid=123)
        process.children.return_value = []
        with patch.object(cleanup, 'account_processes', side_effect=[[process], []]) as scan, \
             patch.object(cleanup.psutil, 'wait_procs', return_value=([process], [])):
            count = cleanup.stop_account(self.root, self.account['id'])
        self.assertEqual(count, 1); self.assertEqual(scan.call_count, 2)
        process.suspend.assert_called_once(); process.terminate.assert_called_once()


if __name__ == '__main__': unittest.main()
