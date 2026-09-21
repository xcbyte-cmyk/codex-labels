"""Opt-in real Tk widget flows with disposable account data, never live profiles."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_prepare_runtime import builder
import account_profiles as profiles
import account_cleanup as cleanup


@unittest.skipUnless(os.environ.get('CODEX_LABELS_ACCOUNT_UI_TESTS') == '1', 'Native account picker UI is opt-in')
class AccountManagerTests(unittest.TestCase):
    def test_existing_default_profile_is_preselected_without_new_credentials(self):
        import account_manager as manager
        import tkinter as tk
        from tkinter import ttk
        with tempfile.TemporaryDirectory() as temporary:
            root_path = Path(temporary)
            original_tk = tk.Tk
            observed = {}
            def create_window():
                window = original_tk(); window.withdraw()
                def inspect():
                    try:
                        frame = window.winfo_children()[0]
                        tree = next(child for child in frame.winfo_children() if isinstance(child, ttk.Treeview))
                        observed['rows'] = tree.get_children()
                        observed['selection'] = tree.selection()
                        observed['name'] = tree.item('default', 'values')[0]
                        observed['accounts'] = profiles.list_accounts(root_path)
                    finally: window.destroy()
                window.after(50, inspect)
                return window
            with patch.object(manager.tk, 'Tk', side_effect=create_window):
                manager.run(root_path, Mock(), Mock(), launch_default=Mock())
            self.assertEqual(observed['rows'], ('default',))
            self.assertEqual(observed['selection'], ('default',))
            self.assertIn('현재 계정', observed['name'])
            self.assertEqual(observed['accounts'], [])

    def exercise(self, confirm, fail=False):
        import account_manager as manager
        import tkinter as tk
        from tkinter import ttk
        with tempfile.TemporaryDirectory() as temporary:
            root_path = Path(temporary)
            target = profiles.create(root_path, '삭제할 계정')
            keep = profiles.create(root_path, '유지할 계정')
            target_path = profiles.account_path(root_path, target['id'])
            (target_path/'private.txt').write_text('fixture')
            stop = Mock(return_value=0, side_effect=RuntimeError('locked process') if fail else None)
            original_tk = tk.Tk
            errors = []
            called = []
            def delete(root, account_id, **kwargs):
                called.append(account_id)
                return cleanup.delete_account(root, account_id, stop=stop, **kwargs)
            def create_window():
                window = original_tk(); window.withdraw()
                def descendants(parent):
                    for child in parent.winfo_children():
                        yield child
                        yield from descendants(child)
                def start():
                    try:
                        widgets = list(descendants(window))
                        tree = next(w for w in widgets if isinstance(w, ttk.Treeview))
                        tree.selection_set(target['id'])
                        button = next(w for w in widgets if isinstance(w, ttk.Button) and w.cget('text') == '선택한 계정 삭제')
                        button.invoke()
                        window.after(200, lambda: verify(tree, 0))
                    except Exception as error: errors.append(error); window.destroy()
                def verify(tree, attempts):
                    try:
                        rows = [tree.item(i, 'values')[0] for i in tree.get_children()]
                        ready = (not confirm or (fail and any('삭제 미완료' in value for value in rows)) or
                                 (confirm and not fail and target['id'] not in tree.get_children()))
                        if not ready and attempts < 40:
                            window.after(100, lambda: verify(tree, attempts + 1)); return
                        self.assertTrue(ready, rows)
                        self.assertIn(keep['id'], tree.get_children())
                        if confirm and not fail:
                            self.assertFalse(target_path.exists())
                            self.assertFalse(profiles.deletion_marker(root_path, target['id']).exists())
                        else: self.assertTrue((target_path/'private.txt').exists())
                        if not confirm: self.assertEqual(called, [])
                        else: self.assertEqual(called, [target['id']])
                    except Exception as error: errors.append(error)
                    finally:
                        if ready or attempts >= 40: window.destroy()
                window.after(50, start)
                return window
            with patch.object(manager.tk, 'Tk', side_effect=create_window), \
                 patch.object(manager.messagebox, 'askyesno', return_value=confirm) as dialog:
                manager.run(root_path, Mock(), delete)
            self.assertEqual(errors, [])
            self.assertIn('삭제할 계정', dialog.call_args.args[1])
            self.assertEqual(dialog.call_args.kwargs['default'], 'no')

    def test_delete_cancel_keeps_data_and_does_not_invoke_deletion(self): self.exercise(False)
    def test_confirmed_delete_refreshes_list_and_removes_data(self): self.exercise(True)
    def test_failed_delete_remains_visible_for_retry(self): self.exercise(True, fail=True)


if __name__ == '__main__': unittest.main()
