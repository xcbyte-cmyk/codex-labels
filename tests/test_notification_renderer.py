"""Real Chromium, synthetic sidebar/preload. This is NOT a Windows toast E2E test."""
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'Browser tests are opt-in')
class NotificationRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.driver = sync_playwright().start()
        cls.browser = cls.driver.chromium.launch(headless=True, executable_path=os.environ.get('CODEX_LABELS_CHROMIUM'))
        cls.source = (ROOT/'extension/notification-renderer.js').read_text(encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.driver.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(5000)
        self.addCleanup(self.page.close)
        self.page.set_content('<html><body><div id="rows"></div></body></html>')
        self.page.evaluate('''() => {
            window.events = {ready: 0, acks: [], clicked: [], notices: [], unsubscribed: 0};
            window.codexLabels = {
                onActivateThread: fn => { window.deliver = fn; return () => { events.unsubscribed++; }; },
                activationReady: async () => { events.ready++; },
                acknowledgeActivation: async (...args) => { events.acks.push(args); },
                notifyThread: async value => { events.notices.push(value); return {accepted: true}; }
            };
            window.addRow = (id, host = 'local', kind = 'local') => {
                const row = document.createElement('div');
                row.dataset.appActionSidebarThreadRow = '';
                row.dataset.appActionSidebarThreadId = id;
                row.dataset.appActionSidebarThreadHostId = host;
                row.dataset.appActionSidebarThreadKind = kind;
                const badge = document.createElement('span'); badge.className = 'cdx-label';
                badge.setAttribute('role', 'button'); badge.tabIndex = 0; badge.textContent = '＋';
                row.append(badge, document.createTextNode(' synthetic task'));
                row.onclick = () => events.clicked.push([id, host, kind]);
                document.querySelector('#rows').append(row);
                return row;
            };
        }''')
        # The notification capture listener must be installed FIRST.
        self.page.add_script_tag(content=self.source)
        # Mirror the upstream label renderer's stopImmediatePropagation behavior.
        self.page.evaluate('''() => {
            for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
                if (!(event.target instanceof Element) || !event.target.closest('.cdx-label')) return;
                if (type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
                event.preventDefault(); event.stopImmediatePropagation();
                document.querySelector('#cdx-label-menu')?.remove();
                const menu = document.createElement('div'); menu.id = 'cdx-label-menu';
                document.body.append(menu);
            }, true);
        }''')

    def activate(self, event='e1', thread='task', host='local', kind='local'):
        self.page.evaluate('(r) => deliver(r)', dict(eventId=event, threadId=thread, hostId=host, kind=kind))

    def test_renderer_ready_handshake(self):
        self.assertEqual(self.page.evaluate('events.ready'), 1)
        self.page.add_script_tag(content=self.source)
        self.assertEqual(self.page.evaluate('events.ready'), 1)

    def test_full_identity_selects_remote_row_not_same_id_on_local(self):
        self.page.evaluate("() => { addRow('task'); addRow('task', 'remote-ssh-discovered:qa-runner', 'remote'); }")
        self.activate(host='remote-ssh-discovered:qa-runner', kind='remote')
        self.page.wait_for_function('events.acks.length === 1')
        self.assertEqual(self.page.evaluate('events.clicked'), [['task', 'remote-ssh-discovered:qa-runner', 'remote']])
        self.assertEqual(self.page.evaluate('events.acks'), [['e1', 'navigation-requested']])

    def test_real_sidebar_kind_prefix_is_normalized_for_activation(self):
        self.page.evaluate("addRow('local:task')")
        self.activate(thread='task')
        self.page.wait_for_function('events.acks.length === 1')
        self.assertEqual(self.page.evaluate('events.clicked'), [['local:task', 'local', 'local']])
        self.page.locator('.cdx-label').click()
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.assertEqual(self.page.evaluate('events.notices[0].threadId'), 'task')

    def test_late_mounted_row_is_navigated_once(self):
        self.activate()
        self.assertEqual(self.page.evaluate('events.clicked.length'), 0)
        self.page.evaluate("addRow('task')")
        self.page.wait_for_function('events.clicked.length === 1')
        self.page.evaluate("() => { for (let i = 0; i < 100; i++) document.body.append(document.createElement('p')); }")
        self.assertEqual(self.page.evaluate('events.clicked.length'), 1)

    def test_missing_or_wrong_host_never_opens_another_task(self):
        self.page.clock.install()
        self.page.evaluate("addRow('task', 'wrong-host')")
        self.activate()
        self.page.clock.fast_forward(8100)
        self.assertEqual(self.page.evaluate('events.clicked'), [])
        self.assertEqual(self.page.evaluate('events.acks'), [['e1', 'thread-not-found']])
        self.assertIn('현재 목록에 없습니다', self.page.locator('#codex-labels-notification-status').inner_text())

    def test_newest_activation_cancels_previous_wait(self):
        self.activate('e1', 'old')
        self.activate('e2', 'new')
        self.page.evaluate("() => { addRow('old'); addRow('new'); }")
        self.page.wait_for_function('events.acks.length === 1')
        self.assertEqual(self.page.evaluate('events.clicked'), [['new', 'local', 'local']])
        self.assertEqual(self.page.evaluate('events.acks[0][0]'), 'e2')

    def test_menu_test_button_coexists_with_upstream_capture_handler(self):
        self.page.evaluate("addRow('task', 'remote-ssh-discovered:qa-runner', 'remote')")
        self.page.locator('.cdx-label').click()
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.page.wait_for_function('events.notices.length === 1')
        notice = self.page.evaluate('events.notices[0]')
        self.assertEqual((notice['threadId'], notice['hostId'], notice['kind']), ('task', 'remote-ssh-discovered:qa-runner', 'remote'))
        self.assertEqual(self.page.evaluate('events.clicked'), [])

    def test_keyboard_menu_also_exposes_test_action(self):
        self.page.evaluate("addRow('task')")
        self.page.locator('.cdx-label').focus()
        self.page.keyboard.press('Enter')
        self.page.get_by_role('menuitem', name='알림 연결 테스트').wait_for(state='visible')
        self.assertEqual(self.page.get_by_role('menuitem', name='알림 연결 테스트').count(), 1)

    def show_notification_error(self):
        self.page.evaluate("() => { addRow('task'); codexLabels.notifyThread = async () => { throw Error('알림 등록 필요'); }; }")
        self.page.locator('.cdx-label').click()
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.page.get_by_role('button', name='알림 메시지 닫기').wait_for()

    def test_error_can_be_dismissed_by_button_and_escape(self):
        self.show_notification_error()
        self.page.get_by_role('button', name='알림 메시지 닫기').click()
        self.assertEqual(self.page.locator('#codex-labels-notification-status').count(), 0)
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.page.get_by_role('button', name='알림 메시지 닫기').wait_for()
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.locator('#codex-labels-notification-status').count(), 0)

    def test_repeated_error_resets_auto_dismiss_timer(self):
        self.page.clock.install()
        self.show_notification_error()
        self.page.clock.fast_forward(11000)
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.page.clock.fast_forward(11000)
        self.assertEqual(self.page.locator('#codex-labels-notification-status').count(), 1)
        self.page.clock.fast_forward(1100)
        self.assertEqual(self.page.locator('#codex-labels-notification-status').count(), 0)

    def test_successful_retry_clears_previous_error(self):
        self.show_notification_error()
        self.page.evaluate("codexLabels.notifyThread = async () => ({accepted: true})")
        self.page.get_by_role('menuitem', name='알림 연결 테스트').click()
        self.page.locator('#codex-labels-notification-status').wait_for(state='detached')

    def test_cross_window_cancellation_prevents_obsolete_late_navigation(self):
        self.page.clock.install()
        self.activate()
        self.page.evaluate("deliver({eventId: 'e1', cancel: true})")
        self.page.evaluate("addRow('task')")
        self.page.clock.fast_forward(9000)
        self.assertEqual(self.page.evaluate('events.clicked'), [])
        self.assertEqual(self.page.evaluate('events.acks'), [])

    def test_pagehide_unsubscribes_and_cancels_pending_delivery(self):
        self.page.clock.install()
        self.activate()
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        self.page.clock.fast_forward(9000)
        self.assertEqual(self.page.evaluate('events.unsubscribed'), 1)
        self.assertEqual(self.page.evaluate('events.acks'), [])


if __name__ == '__main__':
    unittest.main()
