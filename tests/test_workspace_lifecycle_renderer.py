"""Lifecycle status UI tests use an explicit mock bridge, never live credentials."""
import os
from pathlib import Path
import unittest
import test_workspace_switcher_renderer as fixtures

@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'opt-in browser tests')
class WorkspaceLifecycleRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True,
            executable_path=os.environ.get('CODEX_LABELS_CHROMIUM') or None, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    setUp = fixtures.WorkspaceSwitcherRendererTests.setUp

    def change_state(self, **values):
        self.page.evaluate('(v) => {Object.assign(window.state,v); window.callbacks.forEach(f=>f());}', values)
        self.page.wait_for_timeout(120)

    def test_verified_connection_counts_are_visible(self):
        self.change_state(connectionCount=2, verifiedConnectionCount=2)
        text = self.page.get_by_role('status').inner_text()
        self.assertIn('앱 서버 연결: 2개', text)
        self.assertIn('계정 확인 완료: 2개', text)
        self.assertEqual(self.page.locator('aside').inner_text(), '대화 A · 대화 B · 대화 C')

    def test_synchronizing_connection_blocks_switch_then_recovers_without_reopening_dialog(self):
        self.page.locator('select').select_option('b')
        self.page.get_by_role('checkbox').check()
        self.change_state(phase='synchronizing', connectionCount=2, verifiedConnectionCount=1)
        change = self.page.get_by_role('button', name='전체 작업 공간의 계정 전환', exact=True)
        self.assertFalse(change.is_enabled())
        self.assertIn('새 연결의 계정을 확인', self.page.get_by_role('status').inner_text())
        preview = os.environ.get('CODEX_LABELS_LIFECYCLE_PREVIEW')
        if preview:
            target = Path(preview)
            target.parent.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(target))
        self.change_state(phase='idle', verifiedConnectionCount=2)
        self.assertTrue(change.is_enabled())
        self.assertEqual(self.page.locator('dialog[open]').count(), 1)

    def test_retiring_unconfirmed_process_is_explicit_and_disables_new_switch(self):
        self.change_state(phase='blocked', blockedReason='CLEANUP_FAILED',
                          connectionCount=1, verifiedConnectionCount=1, retiringConnectionCount=1)
        self.assertIn('종료 확인 중인 연결: 1개', self.page.get_by_role('status').inner_text())
        self.assertFalse(self.page.get_by_role('button', name='전체 작업 공간의 계정 전환', exact=True).is_enabled())

if __name__ == '__main__':
    unittest.main()
