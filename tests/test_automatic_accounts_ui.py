"""Real Tk widgets under a virtual display; synthetic credentials/backends only."""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from automatic_accounts import Credential, Vault, read_private, atomic_write
from automatic_accounts_ui import Picker
from test_automatic_accounts import credential, TestProtector, FakeDesktop, FakeVerifier
@unittest.skipUnless(os.environ.get('CODEX_LABELS_TK_TESTS')=='1','Native UI widget tests are opt-in')
class PickerTests(unittest.TestCase):
    def setUp(self):
        import tkinter as tk
        self.t=tempfile.TemporaryDirectory();self.root=Path(self.t.name)
        self.home=self.root/'home';self.home.mkdir();atomic_write(self.home/'auth.json',credential('A').raw)
        self.vault=Vault(self.root/'vault',TestProtector());self.bid=self.vault.save(credential('B'),'작업 계정 B')
        self.log=[];self.desktop=FakeDesktop(self.log);self.verifier=FakeVerifier(self.log)
        self.ui=tk.Tk();self.ui.geometry('720x600');self.p=Picker(self.ui,self.home,self.vault,self.verifier,self.desktop)
        self.ui.update()
    def tearDown(self):
        if self.p.busy:
            self.p.cancelled.set()
            end=time.monotonic()+3
            while self.p.busy and time.monotonic()<end:self.ui.update();time.sleep(.02)
        self.p.destroy();self.t.cleanup()
    def settle(self):
        end=time.monotonic()+4
        while self.p.busy and time.monotonic()<end:self.ui.update();time.sleep(.02)
        self.assertFalse(self.p.busy)
    def test_current_account_is_pre_registered(self):
        self.assertEqual(len(self.vault.list()),2);self.assertTrue(self.p.tree.selection())
    def test_switch_button_automates_file_verification_and_relaunch(self):
        self.p.tree.selection_set(self.bid);self.p.saved.set(True);self.p.consent.set(True)
        with patch('automatic_accounts_ui.messagebox.askyesno',return_value=True):self.p.change.invoke()
        self.settle()
        self.assertEqual(Credential.parse(read_private(self.home/'auth.json')).identity,credential('B').identity)
        self.assertIn('exit',self.log);self.assertIn('reopen',self.log);self.assertTrue(self.p.completed)
    def test_missing_consent_cannot_trigger_handoff(self):
        self.p.tree.selection_set(self.bid);self.p.change.invoke();self.ui.update()
        self.assertEqual(self.log,[]);self.assertIn('확인',self.p.status.get())
    def test_cancel_confirmation_leaves_app_and_credentials(self):
        self.p.tree.selection_set(self.bid);self.p.saved.set(True);self.p.consent.set(True)
        with patch('automatic_accounts_ui.messagebox.askyesno',return_value=False):self.p.change.invoke()
        self.assertEqual(self.log,[])
    def test_broken_exit_is_displayed_without_success(self):
        self.desktop.exit_fails=True;self.p.tree.selection_set(self.bid);self.p.saved.set(True);self.p.consent.set(True)
        with patch('automatic_accounts_ui.messagebox.askyesno',return_value=True):self.p.change.invoke()
        self.settle();self.assertIn('종료가 확인되지',self.p.status.get());self.assertFalse(self.p.completed)
    def test_browser_registration_stays_separate_from_active_workspace(self):
        self.verifier.browser_login=lambda **kw:credential('C')
        with patch('automatic_accounts_ui.simpledialog.askstring',return_value='새 계정 C'):self.p.add.invoke()
        self.settle();self.assertEqual(len(self.vault.list()),3)
        self.assertEqual(read_private(self.home/'auth.json'),credential('A').raw)
    def test_pending_recovery_disables_normal_switch(self):
        self.vault.begin(credential('A'),credential('B'));self.p.controls()
        self.assertTrue(self.p.change.instate(['disabled']));self.assertTrue(self.p.recover.instate(['!disabled']))
if __name__=='__main__':unittest.main()
