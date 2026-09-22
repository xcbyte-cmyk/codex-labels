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
                        button = next(w for w in widgets if isinstance(w, ttk.Button) and w.cget('text') == '실행환경 삭제')
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

    def test_environment_switch_passes_selected_environment_without_launching_another(self):
        import account_manager as manager
        import tkinter as tk
        from tkinter import ttk
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            chosen = profiles.create(root, '환경 A')
            other = profiles.create(root, '환경 B')
            original_tk = tk.Tk
            errors = []
            switch, launch = Mock(return_value={}), Mock()
            def create_window():
                window = original_tk(); window.withdraw()
                def children(parent):
                    for child in parent.winfo_children():
                        yield child
                        yield from children(child)
                def act():
                    try:
                        widgets = list(children(window))
                        tree = next(w for w in widgets if isinstance(w, ttk.Treeview))
                        self.assertIn(other['id'], tree.get_children())
                        self.assertEqual(tree.item(chosen['id'], 'values')[1], 'synthetic@example.invalid')
                        tree.selection_set(chosen['id'])
                        next(w for w in widgets if isinstance(w, ttk.Button) and w.cget('text') == '연결 계정 전환').invoke()
                    except Exception as error:
                        errors.append(error); window.destroy()
                window.after(50, act)
                window.after(4000, window.destroy)
                return window
            with patch.object(manager.tk, 'Tk', side_effect=create_window):
                manager.run(root, launch, Mock(), switch_account=switch,
                            describe_account=lambda _: 'synthetic@example.invalid', close_on_launch=True)
            self.assertEqual(errors, [])
            self.assertEqual(switch.call_args.args, (root, chosen['id']))
            launch.assert_not_called()


if __name__ == '__main__': unittest.main()
