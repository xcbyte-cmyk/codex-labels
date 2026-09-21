"""Chromium tests of the workspace UI against an explicit bridge double."""
import json
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'opt-in browser tests')
class WorkspaceSwitcherRendererTests(unittest.TestCase):
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
        self.page = self.browser.new_page(viewport={'width': 1100, 'height': 850})
        self.addCleanup(self.page.close)
        self.page.set_content('<html><head></head><body><aside>대화 A · 대화 B · 대화 C</aside><main>기존 작업</main></body></html>')
        self.page.evaluate('''() => {
          window.calls = []; window.callbacks = []; window.failSwitch = false;
          window.state = {scope:'workspace', phase:'idle',activeProfile:{id:'a',name:'현재 계정 A'},
            workspaceHome:'C:\\\\Users\\\\test\\\\.codex',localConversationCount:611};
          window.codexSessionSwitcher = {
            status:async()=>({ok:true,value:{scope:'workspace',attached:true,state:window.state,
              profiles:[{id:'a',name:'현재 계정 A'},{id:'b',name:'계정 B'}]}}),
            inspect:async()=>({ok:true,value:window.state}),
            switchAccount:async v=>{
              window.calls.push(v);
              if(window.hold) await new Promise(resolve=>window.release=resolve);
              if(window.failSwitch) {window.state.phase='blocked';return {ok:false,error:{message:'선택한 계정의 인증을 확인하지 못했습니다.'}};}
              window.state={...window.state,activeProfile:{id:v.profileId,name:'계정 B'}};
              return {ok:true,value:{state:window.state}};
            },
            recover:async v=>{window.calls.push({recover:v});return {ok:true,value:window.state};},
            cancel:async()=>{window.calls.push({cancel:true});return {ok:true,value:true};},
            usage:async()=>({ok:true,value:{rateLimits:{primary:{usedPercent:20}}}}),
            onChanged:fn=>{window.callbacks.push(fn);return()=>window.callbacks.splice(window.callbacks.indexOf(fn),1);}
          };
        }''')
        self.page.add_script_tag(path=str(ROOT/'extension/session-switcher-renderer.js'))
        self.page.get_by_role('button', name='Account Switcher', exact=True).click()
        self.page.wait_for_function("document.querySelector('select')?.options.length === 2")

    def test_global_ui_has_no_thread_selector_and_keeps_sidebar(self):
        self.assertEqual(self.page.locator('select').count(), 1)
        self.assertEqual(self.page.locator('aside').inner_text(), '대화 A · 대화 B · 대화 C')
        self.assertIn('611', self.page.get_by_role('status').inner_text())

    def test_switch_requires_consent_and_sends_no_thread_id(self):
        change = self.page.get_by_role('button', name='전체 작업 공간의 계정 전환', exact=True)
        self.page.locator('select').select_option('b')
        self.assertFalse(change.is_enabled())
        self.page.get_by_role('checkbox').check()
        change.click()
        self.assertEqual(self.page.evaluate('window.calls[0]'), {'profileId':'b','confirmContextTransfer':True})
        self.assertIn('계정 B', self.page.get_by_role('status').inner_text())
        self.assertFalse(self.page.get_by_role('checkbox').is_checked())

    def test_failure_shows_error_and_allows_explicit_recovery(self):
        self.page.evaluate('window.failSwitch=true')
        self.page.locator('select').select_option('b')
        self.page.get_by_role('checkbox').check()
        self.page.get_by_role('button', name='전체 작업 공간의 계정 전환', exact=True).click()
        self.page.wait_for_function("document.querySelector('[role=status]').textContent.includes('인증을 확인하지 못했습니다')")
        self.page.get_by_role('checkbox').check()
        self.assertTrue(self.page.get_by_role('button', name='로그인 확인·복구', exact=True).is_enabled())
        self.page.get_by_role('button', name='로그인 확인·복구', exact=True).click()
        self.assertEqual(self.page.evaluate('window.calls[1]'), {'recover':{'confirmContextTransfer':True}})

    def test_close_cannot_abandon_switch_in_progress(self):
        self.page.evaluate('window.hold=true')
        self.page.locator('select').select_option('b')
        self.page.get_by_role('checkbox').check()
        self.page.get_by_role('button', name='전체 작업 공간의 계정 전환', exact=True).click()
        self.assertFalse(self.page.get_by_role('button', name='닫기', exact=True).is_enabled())
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.locator('dialog[open]').count(), 1)
        self.page.get_by_role('button', name='전환 취소', exact=True).click()
        self.assertTrue(self.page.evaluate('window.calls.some(v=>v.cancel)'))
        self.page.evaluate('window.release()')

    def test_close_unsubscribes_and_reopen_does_not_duplicate_handlers(self):
        self.page.get_by_role('button', name='닫기', exact=True).click()
        self.page.wait_for_function('window.callbacks.length === 0')
        self.assertEqual(self.page.evaluate('window.callbacks.length'), 0)
        self.page.get_by_role('button', name='Account Switcher', exact=True).click()
        self.assertEqual(self.page.evaluate('window.callbacks.length'), 1)

if __name__ == '__main__':
    unittest.main()
