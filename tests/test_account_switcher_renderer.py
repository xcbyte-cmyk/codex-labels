"""Real Chromium UI regression using synthetic IPC; no Codex credentials or network."""
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'opt-in Chromium tests')
class AccountSwitcherRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True, executable_path=os.environ.get('CODEX_LABELS_CHROMIUM') or None,
            args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1000, 'height': 800})
        self.page.set_content('<html><head></head><body><textarea id="draft"></textarea>'
                              '<main style="height:200px;overflow:auto"><div style="height:2000px">Project</div></main></body></html>')
        self.page.evaluate("""() => {
          window.calls = [];
          window.state = {available:true, phase:'ready', profileId:'a', busy:false};
          window.profiles = [{id:'a',name:'Personal',signedIn:true,email:'a@example.test'},
            {id:'b',name:'<img src=x onerror=alert(1)>',signedIn:true,email:'b@example.test'}];
          window.codexLabelsAccounts = {
            list: async () => ({state:window.state,profiles:window.profiles}),
            usage: async id => { calls.push(['usage',id]); return {profileId:id,usage:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:2000000000},secondary:null,checkedAt:'2026-09-21T01:00:00Z'}}; },
            switchTo: async (id,consent) => { calls.push(['switch',id,consent]);
              if(window.failSwitch) throw Error('TOKEN_SECRET_MUST_NOT_APPEAR');
              window.state = {...window.state,profileId:id};return {state:window.state,resumedThreads:2}; },
            onState: callback => {window.notify=callback;return ()=>{window.unsubscribed=true;};}
          };
        }""")
        self.page.add_script_tag(path=str(ROOT / 'extension/account-switcher-renderer.js'))
        self.page.wait_for_function("document.querySelector('#codex-labels-account-switch').textContent.includes('Personal')")

    def tearDown(self):
        self.page.close()

    def open(self):
        self.page.locator('#codex-labels-account-switch').click()
        self.page.get_by_role('button', name='이 계정으로 전환').nth(1).wait_for()

    def test_explicit_consent_and_draft_scroll_preservation(self):
        self.page.locator('#draft').fill('unfinished project instructions')
        self.page.evaluate("""() => {
          window.originalDraft=document.querySelector('#draft');
          originalDraft.setSelectionRange(3,7);document.querySelector('main').scrollTop=500;
        }""")
        self.open()
        self.page.get_by_role('button', name='이 계정으로 전환').nth(1).click()
        self.assertEqual(self.page.evaluate('calls.length'), 0)
        self.page.get_by_role('button', name='확인하고 전환').click()
        self.page.wait_for_function("calls.length===1 && document.querySelector('#codex-labels-account-dialog').textContent.includes('복원 확인')")
        self.assertEqual(self.page.evaluate('calls'), [['switch', 'b', True]])
        self.assertTrue(self.page.evaluate("originalDraft===document.querySelector('#draft')"))
        self.assertEqual(self.page.locator('#draft').input_value(), 'unfinished project instructions')
        self.assertEqual(self.page.evaluate("document.querySelector('main').scrollTop"), 500)
        self.assertEqual(self.page.evaluate('originalDraft.selectionStart'), 3)

    def test_account_names_are_text_not_html(self):
        self.open()
        self.assertEqual(self.page.locator('#codex-labels-account-dialog img').count(), 0)
        self.assertIn('<img src=x', self.page.locator('#codex-labels-account-dialog').inner_text())

    def test_usage_unknown_is_not_zero_and_refresh_is_explicit(self):
        self.open()
        self.assertIn('사용량 미조회', self.page.locator('#codex-labels-account-dialog').inner_text())
        self.assertEqual(self.page.evaluate('calls.length'), 0)
        self.page.get_by_role('button', name='사용량 조회').nth(1).click()
        self.page.wait_for_function("document.querySelector('#codex-labels-account-dialog').textContent.includes('12% 사용')")
        self.assertEqual(self.page.evaluate('calls'), [['usage', 'b']])

    def test_busy_change_updates_buttons_without_erasing_confirmation(self):
        self.open()
        self.page.evaluate("notify({...state,busy:true})")
        self.assertTrue(self.page.get_by_role('button', name='이 계정으로 전환').nth(1).is_disabled())
        self.page.evaluate("notify({...state,busy:false})")
        self.page.get_by_role('button', name='이 계정으로 전환').nth(1).click()
        self.page.evaluate("notify({...state,busy:false})")
        self.assertEqual(self.page.get_by_role('button', name='확인하고 전환').count(), 1)
        self.assertEqual(self.page.evaluate('calls.length'), 0)

    def test_failure_does_not_expose_backend_errors(self):
        self.page.evaluate('window.failSwitch=true')
        self.open()
        self.page.get_by_role('button', name='이 계정으로 전환').nth(1).click()
        self.page.get_by_role('button', name='확인하고 전환').click()
        self.page.wait_for_function("document.querySelector('#codex-labels-account-dialog').textContent.includes('완료하지 못했습니다')")
        self.assertNotIn('TOKEN_SECRET', self.page.locator('body').inner_text())
        self.assertIn('Personal', self.page.locator('#codex-labels-account-switch').inner_text())

    def test_unsupported_backend_has_no_enabled_switch(self):
        self.page.evaluate("window.state={...window.state,available:false,phase:'unavailable'}")
        self.open()
        self.assertTrue(self.page.get_by_role('button', name='이 계정으로 전환').nth(1).is_disabled())
        self.assertEqual(self.page.evaluate('calls.length'), 0)


if __name__ == '__main__':
    unittest.main()
