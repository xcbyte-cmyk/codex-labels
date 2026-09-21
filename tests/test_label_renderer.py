"""Real Chromium with synthetic sidebar/preload; never opens the user's config.

Set CODEX_LABELS_RENDERER_SOURCE to compare the same DOM workload with an older
renderer. Work counters measure DOM operations, not CPU time or native app speed.
"""
import json
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'Browser tests are opt-in')
class LabelRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.driver = sync_playwright().start()
        cls.browser = cls.driver.chromium.launch(headless=True, executable_path=os.environ.get('CODEX_LABELS_CHROMIUM'))
        source = Path(os.environ.get('CODEX_LABELS_RENDERER_SOURCE', ROOT/'extension/renderer.js'))
        cls.source = source.read_text(encoding='utf-8')
        cls.config = json.loads((ROOT/'labels.example.json').read_text(encoding='utf-8'))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.driver.stop()

    def setUp(self):
        self.page = self.browser.new_page()
        self.page.set_default_timeout(5000)
        self.addCleanup(self.page.close)
        self.page.set_content('<html><body><aside id="sidebar"></aside><main id="chat"></main></body></html>')
        self.page.evaluate('''config => {
            const copy = value => JSON.parse(JSON.stringify(value));
            window.fixture = {
                data: {config, assignments: {}, configRevision: 'c1', snapshotVersion: 's1', configError: null},
                sequence: 1, listeners: new Set(), reads: [], assignments: [], saves: [], reports: [],
                activeReads: 0, maxActiveReads: 0, unsubscribed: 0, accountSelectorOpens: 0,
                scans: {}, badgeWrites: new Set(), nextReadHeld: false, nextAssignHeld: false,
                emit() { for (const listener of this.listeners) listener(); },
                advance(configChanged = false) {
                    this.data.snapshotVersion = 's' + (++this.sequence);
                    if (configChanged) this.data.configRevision = 'c' + this.sequence;
                },
                assign(updates, emit = true) {
                    for (const [key, value] of Object.entries(updates)) {
                        if (value === null) delete this.data.assignments[key];
                        else this.data.assignments[key] = value;
                    }
                    this.advance(); if (emit) this.emit();
                },
                resetWork() { this.scans = {}; this.badgeWrites.clear(); },
                work() { return {scans: {...this.scans}, badgeWrites: [...this.badgeWrites].sort()}; }
            };
            window.codexLabels = {
                async read(knownVersion) {
                    fixture.reads.push(knownVersion ?? null);
                    fixture.activeReads++;
                    fixture.maxActiveReads = Math.max(fixture.maxActiveReads, fixture.activeReads);
                    const response = knownVersion === fixture.data.snapshotVersion ? null : copy(fixture.data);
                    try {
                        if (fixture.nextReadHeld) {
                            fixture.nextReadHeld = false;
                            return await new Promise(resolve => { fixture.releaseRead = () => resolve(response); });
                        }
                        return response;
                    } finally { fixture.activeReads--; }
                },
                onChanged(callback) {
                    fixture.listeners.add(callback);
                    return () => { fixture.listeners.delete(callback); fixture.unsubscribed++; };
                },
                async assign(key, value) {
                    fixture.assignments.push([key, value]);
                    fixture.assign({[key]: value}, false);
                    const response = copy(fixture.data);
                    if (fixture.nextAssignHeld) {
                        fixture.nextAssignHeld = false;
                        return await new Promise(resolve => { fixture.releaseAssign = () => resolve(response); });
                    }
                    return response;
                },
                async saveConfig(draft, revision) {
                    fixture.saves.push({draft: copy(draft), revision});
                    if (revision !== fixture.data.configRevision) throw Error('conflict');
                    Object.assign(fixture.data.config, copy(draft)); fixture.advance(true);
                    return copy(fixture.data);
                },
                async openConfig() {},
                async openAccountSelector() { fixture.accountSelectorOpens++; },
                async report(value) { fixture.reports.push(value); }
            };
            window.addRow = (id, options = {}) => {
                const row = document.createElement('div'); row.id = id;
                if (options.project) {
                    row.dataset.appActionSidebarProjectRow = '';
                    row.dataset.appActionSidebarProjectId = options.project;
                    row.dataset.appActionSidebarProjectLabel = options.title || id;
                } else {
                    row.dataset.appActionSidebarThreadRow = '';
                    row.dataset.appActionSidebarThreadId = options.thread || id;
                    row.dataset.appActionSidebarThreadHostId = options.host || 'local';
                    row.dataset.appActionSidebarThreadKind = options.kind || 'local';
                    row.dataset.appActionSidebarThreadTitle = options.title || id;
                }
                const title = document.createElement('span'); title.className = 'task-title';
                title.textContent = options.title || id; row.append(title);
                document.querySelector('#sidebar').append(row); return row;
            };
            const createTreeWalker = document.createTreeWalker.bind(document);
            document.createTreeWalker = (root, ...args) => {
                if (root.id) fixture.scans[root.id] = (fixture.scans[root.id] || 0) + 1;
                return createTreeWalker(root, ...args);
            };
            new MutationObserver(records => {
                for (const record of records) {
                    const target = record.target instanceof Element ? record.target : record.target.parentElement;
                    const badge = target?.closest('.cdx-label');
                    if (badge) fixture.badgeWrites.add(badge.closest('[data-app-action-sidebar-thread-row],[data-app-action-sidebar-project-row]')?.id);
                }
            }).observe(document.body, {subtree: true, childList: true, attributes: true, characterData: true});
        }''', self.config)

    def settle(self):
        self.page.evaluate('''() => new Promise(resolve => requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))))''')

    def start(self, setup="addRow('first'); addRow('second');"):
        self.page.evaluate('() => {' + setup + '}')
        self.page.add_script_tag(content=self.source)
        self.page.locator('#first .cdx-label').wait_for()
        self.settle()

    def badge(self, row='first'):
        return self.page.locator('#' + row + ' .cdx-label')

    def choose(self, name, row='first'):
        self.badge(row).click()
        self.page.get_by_role('menuitem', name=name, exact=True).click()
        self.settle()

    def test_empty_sidebar_reports_ready_with_zero_counts(self):
        self.page.add_script_tag(content=self.source)
        self.page.wait_for_function('fixture.reports.length > 0')
        self.assertEqual(self.page.evaluate('fixture.reports.at(-1)'), {'rows': 0, 'badges': 0})

    def test_account_selector_entry_opens_existing_picker(self):
        self.start("addRow('first');")
        self.choose('계정 선택기…')
        self.assertEqual(self.page.evaluate('fixture.accountSelectorOpens'), 1)
        self.badge().click()
        self.page.get_by_role('menuitem', name='라벨 설정…').click()
        self.page.get_by_role('button', name='계정 선택기 열기').click()
        self.assertEqual(self.page.evaluate('fixture.accountSelectorOpens'), 2)
        self.assertIn('현재 창의 로그인 계정과 작업은 바뀌지 않습니다.',
                      self.page.locator('#cdx-label-settings').inner_text())

    def test_assign_unset_and_project_use_stable_keys(self):
        self.start("addRow('first'); addRow('project', {project: 'C:/workspace/demo'});")
        self.choose('진행')
        self.assertEqual(self.badge().inner_text(), '진행')
        self.choose('라벨 해제')
        self.assertEqual(self.badge().inner_text(), '＋')
        self.choose('검토', 'project')
        self.assertEqual(self.page.evaluate('fixture.assignments'), [
            ['thread:local:local:first', 'in_progress'], ['thread:local:local:first', None],
            ['project:C:/workspace/demo', 'in_review']])

    def test_label_stays_fixed_outside_moving_title_marquee(self):
        self.start("""
            const row=addRow('first'); row.style.cssText='display:flex;width:260px';
            row.querySelector('.task-title').outerHTML='<span data-marquee-text style="min-width:0;overflow:hidden;flex:1"><span data-marquee-content style="display:block;white-space:nowrap">first</span></span>';
        """)
        badge=self.badge()
        before=badge.bounding_box()
        self.page.locator('[data-marquee-content]').evaluate("e=>e.style.transform='translateX(-90px)'")
        self.page.locator('[data-marquee-text]').hover()
        self.settle()
        self.assertAlmostEqual(badge.bounding_box()['x'],before['x'],delta=0.5)
        self.assertFalse(badge.evaluate("e=>!!e.closest('[data-marquee-text]')"))

    def test_column_title_host_is_normalized_to_one_horizontal_line(self):
        self.start("""
            const row=addRow('first');
            const title=row.querySelector('.task-title');
            title.style.display='flex';title.style.flexDirection='column';title.style.width='180px';
        """)
        host=self.page.locator('#first .task-title')
        badge=self.badge()
        self.assertEqual(host.evaluate('e=>getComputedStyle(e).flexDirection'),'row')
        self.assertLess(abs(badge.bounding_box()['y']-host.bounding_box()['y']),3)
        self.assertTrue(host.evaluate("e=>e.classList.contains('cdx-label-host')"))
        self.choose('진행')
        self.assertEqual(badge.inner_text(),'진행')

    def test_recycled_row_identity_and_replaced_title_are_refreshed(self):
        self.start("""
            addRow('first');
            fixture.assign({'thread:local:local:changed': 'requested',
                'thread:remote-ssh-discovered:qa:remote:changed': 'completed'}, false);
        """)
        self.page.evaluate("document.querySelector('#first').dataset.appActionSidebarThreadId = 'changed'")
        self.settle()
        self.assertEqual(self.badge().inner_text(), '요청')
        self.page.evaluate("""() => {
            const row = document.querySelector('#first');
            row.dataset.appActionSidebarThreadHostId = 'remote-ssh-discovered:qa';
            row.dataset.appActionSidebarThreadKind = 'remote';
            row.dataset.appActionSidebarThreadTitle = 'renamed';
            row.querySelector('.task-title').replaceWith(Object.assign(document.createElement('span'), {className: 'task-title', textContent: 'renamed'}));
        }""")
        self.settle()
        self.assertEqual(self.badge().count(), 1)
        self.assertEqual(self.badge().inner_text(), '완료')
        self.assertEqual(self.badge().get_attribute('data-key'), 'thread:remote-ssh-discovered:qa:remote:changed')
        self.assertEqual(self.page.locator('#first .task-title .cdx-label').count(), 1)
        # Upstream can replace title content without changing any row attribute.
        self.page.evaluate("document.querySelector('#first .task-title').textContent = 'renamed'")
        self.settle()
        self.assertEqual(self.badge().count(), 1)
        self.assertEqual(self.badge().inner_text(), '완료')

    def test_project_key_and_late_title_changes_are_detected(self):
        self.start("""addRow('first'); addRow('project', {project: 'old'});
            fixture.assign({'project:new': 'on_hold'}, false);""")
        self.page.evaluate("""() => {
            const row = document.querySelector('#project');
            row.dataset.appActionSidebarProjectId = 'new';
            row.dataset.appActionSidebarProjectLabel = 'loading title';
        }""")
        self.settle()
        self.assertEqual(self.badge('project').count(), 0)
        self.page.evaluate("document.querySelector('#project .task-title').firstChild.textContent = 'loading title'")
        self.settle()
        self.assertEqual(self.badge('project').inner_text(), '보류')
        self.assertEqual(self.badge('project').get_attribute('data-key'), 'project:new')

    def test_detached_reinserted_late_rows_and_sidebar_replacement(self):
        self.start()
        self.page.evaluate("() => { window.detached = document.querySelector('#first'); detached.remove(); }")
        self.settle()
        self.page.evaluate("() => { document.querySelector('#sidebar').append(detached); addRow('late'); }")
        self.settle()
        self.assertEqual(self.badge().count(), 1)
        self.assertEqual(self.badge('late').count(), 1)
        self.page.evaluate("""() => {
            const next = document.createElement('aside'); next.id = 'sidebar';
            document.querySelector('#sidebar').replaceWith(next); addRow('fresh');
        }""")
        self.settle()
        self.assertEqual(self.badge('fresh').count(), 1)
        self.assertEqual(self.page.locator('.cdx-label').count(), 1)
        self.assertEqual(self.page.evaluate('fixture.reports.at(-1)'), {'rows': 1, 'badges': 1})

    def test_unrelated_chat_mutations_do_not_scan_or_repaint_rows(self):
        self.start("addRow('first'); for (let i = 1; i < 20; i++) addRow('row' + i);")
        self.page.evaluate('fixture.resetWork()')
        self.page.evaluate('''async () => {
            for (let i = 0; i < 20; i++) {
                const node = document.createElement('p'); node.textContent = 'response ' + i;
                document.querySelector('#chat').append(node);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
        }''')
        self.settle()
        work = self.page.evaluate('fixture.work()')
        print('Unrelated chat workload (20 rows, 20 DOM updates): ' + json.dumps(work, sort_keys=True))
        self.assertEqual(work, {'scans': {}, 'badgeWrites': []})

    def test_assignment_event_only_mutates_affected_badge(self):
        self.start()
        self.page.evaluate("() => { fixture.resetWork(); fixture.assign({'thread:local:local:first': 'in_review'}); }")
        self.page.wait_for_function("document.querySelector('#first .cdx-label').textContent === '검토'")
        self.settle()
        self.assertEqual(self.page.evaluate('fixture.work().badgeWrites'), ['first'])
        self.assertEqual(self.badge('second').inner_text(), '＋')

    def test_streaming_chat_scroll_keeps_label_menu_clickable(self):
        self.start()
        self.page.evaluate('''() => {
            const chat = document.querySelector('#chat');
            chat.style.cssText = 'position:fixed;left:400px;top:0;width:300px;height:100px;overflow:auto';
            const content = document.createElement('div'); content.style.height = '2000px';
            chat.append(content);
        }''')
        self.badge().click()
        self.page.evaluate('''async () => {
            const chat = document.querySelector('#chat');
            for (let i = 0; i < 4; i++) {
                chat.firstElementChild.style.height = (2100 + i * 100) + 'px';
                chat.scrollTop = chat.scrollHeight;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
        }''')
        self.settle()
        self.assertEqual(self.page.locator('#cdx-label-menu').count(), 1)
        self.page.get_by_role('menuitem', name='진행', exact=True).click()
        self.settle()
        self.assertEqual(self.badge().inner_text(), '진행')

    def test_menu_scroll_stays_open_but_sidebar_scroll_closes_it(self):
        self.start()
        self.page.evaluate('''() => {
            const sidebar = document.querySelector('#sidebar');
            sidebar.style.cssText = 'width:300px;height:100px;overflow:auto';
            const spacer = document.createElement('div'); spacer.style.height = '1000px';
            sidebar.append(spacer);
        }''')
        self.badge().click()
        self.page.evaluate('''() => {
            const menu = document.querySelector('#cdx-label-menu');
            menu.style.maxHeight = '100px'; menu.scrollTop = menu.scrollHeight;
        }''')
        self.settle()
        self.assertEqual(self.page.locator('#cdx-label-menu').count(), 1)
        self.page.evaluate("document.querySelector('#sidebar').scrollTop = 200")
        self.settle()
        self.assertEqual(self.page.locator('#cdx-label-menu').count(), 0)

    def test_unchanged_conditional_read_does_not_touch_rows(self):
        self.start()
        count = self.page.evaluate('fixture.reads.length')
        self.page.evaluate("() => { fixture.resetWork(); window.dispatchEvent(new Event('focus')); }")
        self.page.wait_for_function('(count) => fixture.reads.length > count', arg=count)
        self.settle()
        self.assertEqual(self.page.evaluate('fixture.reads.at(-1)'), 's1')
        self.assertEqual(self.page.evaluate('fixture.work()'), {'scans': {}, 'badgeWrites': []})

    def test_add_label_save_reopen_and_assign(self):
        self.start()
        self.choose('라벨 설정…')
        self.page.get_by_role('button',name='＋ 라벨 추가',exact=True).click()
        name=self.page.locator('#cdx-label-settings input[name="name"]')
        self.assertEqual(name.input_value(),'새 라벨')
        name.fill('확인 대기')
        self.page.get_by_role('textbox',name='배경색 HEX',exact=True).fill('#AA33CC')
        self.page.get_by_role('button',name='저장',exact=True).click()
        self.page.locator('#cdx-label-settings').wait_for(state='detached')
        self.assertEqual(self.page.evaluate('fixture.data.config.labels.length'),6)
        self.choose('확인 대기')
        self.assertEqual(self.badge().inner_text(),'확인 대기')
        self.choose('라벨 설정…')
        self.page.get_by_role('button',name='확인 대기',exact=True).click()
        self.assertEqual(name.input_value(),'확인 대기')
        self.assertEqual(self.page.get_by_role('textbox',name='배경색 HEX',exact=True).input_value(),'#AA33CC')

    def test_manual_update_check_download_and_restart_message_preserve_label_draft(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.updateCalls=[];
            codexLabels.checkUpdate=async()=>{fixture.updateCalls.push('check');return {currentVersion:'0.2.0',latestVersion:'0.3.0',available:true};};
            codexLabels.stageUpdate=async()=>{fixture.updateCalls.push('stage');return {currentVersion:'0.2.0',downloadedVersion:'0.3.0',latestVersion:'0.3.0',available:false,pendingRestart:true};};
        }''')
        self.choose('라벨 설정…')
        name=self.page.locator('#cdx-label-settings input[name="name"]')
        name.fill('편집 중인 라벨')
        self.assertTrue(self.page.get_by_role('button',name='업데이트 확인',exact=True).is_visible())
        self.page.get_by_text('Codex Labels 업데이트',exact=True).click()
        self.assertTrue(self.page.get_by_role('button',name='업데이트 확인',exact=True).is_visible())
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['check'])
        self.page.get_by_role('button',name='업데이트 확인',exact=True).click()
        self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용',exact=True).click()
        self.assertIn('적용 준비 완료',self.page.get_by_role('status').inner_text())
        self.assertIn('다시 실행',self.page.get_by_role('status').inner_text())
        self.assertEqual(name.input_value(),'편집 중인 라벨')
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['check','check','stage'])
        self.assertFalse(self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용').is_visible())
        self.assertEqual(self.page.evaluate('fixture.saves.length'),0)

    def test_update_error_retry_and_current_version(self):
        self.start()
        self.page.evaluate('''()=>{
            let calls=0;
            codexLabels.checkUpdate=async()=>{if(++calls===1)throw Error('네트워크 연결 실패');return {currentVersion:'0.2.0',latestVersion:'0.1.0',available:false};};
            codexLabels.stageUpdate=async()=>{throw Error('should not download');};
        }''')
        self.choose('라벨 설정…')
        self.page.get_by_text('Codex Labels 업데이트',exact=True).click()
        check=self.page.get_by_role('button',name='업데이트 확인',exact=True)
        self.assertIn('네트워크 연결 실패',self.page.get_by_role('status').inner_text())
        self.assertTrue(check.is_enabled())
        check.click()
        self.assertIn('설치할 새 정식 버전이 없습니다',self.page.get_by_role('status').inner_text())
        self.assertFalse(self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용').is_visible())

    def test_original_codex_change_shows_notice_and_checks_labels_without_installing(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.updateCalls=[];
            const status={currentVersion:'0.2.2',downloadedVersion:'0.2.2',pendingRestart:false,codex:{state:'changed',baseVersion:'26.911.61220',installedVersion:'27.100.1',newer:true}};
            codexLabels.updateStatus=async()=>{fixture.updateCalls.push('local');return status;};
            codexLabels.checkUpdate=async()=>{fixture.updateCalls.push('check');return {...status,available:false,latestVersion:'0.2.2'};};
            codexLabels.stageUpdate=async()=>{throw Error('must not download');};
            codexLabels.restartUpdate=async()=>{throw Error('must not restart');};
        }''')
        self.choose('라벨 설정…')
        notice=self.page.locator('#cdx-codex-notice')
        self.assertTrue(notice.is_visible())
        self.assertIn('새 Codex 버전 감지됨',notice.inner_text())
        self.assertIn('호환성은 아직 확인되지 않았습니다',notice.inner_text())
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['local','check'])
        self.assertFalse(self.page.get_by_role('button',name='설치하고 다시 실행',exact=True).is_visible())
        self.page.get_by_role('button',name='Labels 업데이트 확인',exact=True).click()
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['local','check','check'])
        self.assertEqual(self.page.evaluate('fixture.saves.length'),0)

    def test_same_or_unknown_original_codex_version_has_no_update_notice(self):
        self.start()
        for state in ['same','unavailable']:
            self.page.evaluate('''state=>{
                codexLabels.updateStatus=async()=>({currentVersion:'0.2.2',pendingRestart:false,codex:{state}});
                codexLabels.checkUpdate=async()=>({latestVersion:'0.2.2',available:false});codexLabels.stageUpdate=async()=>({});
            }''',state)
            self.choose('라벨 설정…')
            self.assertFalse(self.page.locator('#cdx-codex-notice').is_visible())
            self.assertIn('설치할 새 정식 버전이 없습니다',self.page.get_by_role('status').inner_text())
            self.page.get_by_role('button',name='취소',exact=True).click()

    def test_automatic_check_shows_loading_and_keeps_label_edits(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.checks=0;
            codexLabels.updateStatus=async()=>({currentVersion:'0.2.1',downloadedVersion:'0.2.1',pendingRestart:false});
            codexLabels.checkUpdate=()=>{fixture.checks++;return new Promise(resolve=>fixture.finishCheck=resolve);};
            codexLabels.stageUpdate=async()=>{throw Error('must not download');};
        }''')
        self.choose('라벨 설정…')
        self.assertIn('공개 최신 버전을 자동으로 확인',self.page.get_by_role('status').inner_text())
        self.assertTrue(self.page.get_by_role('button',name='업데이트 확인',exact=True).is_disabled())
        name=self.page.locator('#cdx-label-settings input[name="name"]')
        name.fill('조회 중 편집')
        self.page.evaluate("fixture.finishCheck({latestVersion:'0.2.2',available:true})")
        self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용',exact=True).wait_for()
        self.assertEqual(name.input_value(),'조회 중 편집')
        self.assertEqual(self.page.evaluate('fixture.checks'),1)

    def test_settings_automatically_checks_available_release_on_each_open(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.checkedRelease=null;fixture.checks=0;
            codexLabels.updateStatus=async()=>({...fixture.checkedRelease,currentVersion:'0.2.1',downloadedVersion:'0.2.1',pendingRestart:false});
            codexLabels.checkUpdate=async()=>{fixture.checks++;return fixture.checkedRelease={latestVersion:'0.2.2',available:true};};
            codexLabels.stageUpdate=async()=>{throw Error('must not download');};
        }''')
        self.choose('라벨 설정…')
        self.assertTrue(self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용',exact=True).is_visible())
        self.assertIn('최근 확인한 공개 버전: v0.2.2',self.page.locator('#cdx-label-settings').inner_text())
        self.page.get_by_role('button',name='취소',exact=True).click()
        self.choose('라벨 설정…')
        self.assertTrue(self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용',exact=True).is_visible())
        self.assertIn('최근 확인한 공개 버전: v0.2.2',self.page.locator('#cdx-label-settings').inner_text())
        self.assertIn('새 버전을 다운로드할 수 있습니다',self.page.get_by_role('status').inner_text())
        self.assertEqual(self.page.evaluate('fixture.checks'),2)

    def test_local_update_status_shows_pending_versions_without_network_and_restarts(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.updateCalls=[];
            codexLabels.updateStatus=async()=>{fixture.updateCalls.push('status');return {currentVersion:'0.2.0',downloadedVersion:'0.3.0',pendingRestart:true};};
            codexLabels.checkUpdate=async()=>{fixture.updateCalls.push('check');throw Error('unexpected network');};
            codexLabels.stageUpdate=async()=>{fixture.updateCalls.push('stage');throw Error('already downloaded');};
            codexLabels.restartUpdate=async()=>{fixture.updateCalls.push('restart');return {restarting:true};};
        }''')
        self.choose('라벨 설정…')
        restart=self.page.get_by_role('button',name='설치하고 다시 실행',exact=True)
        self.assertTrue(restart.is_visible())
        self.assertTrue(restart.is_enabled())
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['status'])
        self.assertIn('실행 중: v0.2.0 · 다운로드된 버전: v0.3.0',self.page.locator('#cdx-label-settings').inner_text())
        self.assertIn('설치 대기',self.page.get_by_role('status').inner_text())
        self.assertTrue(self.page.get_by_text('열린 작업이 중단될 수 있습니다. 저장하지 않은 라벨 편집 내용은 사라집니다.',exact=True).is_visible())
        restart.click()
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['status','restart'])
        self.assertIn('자동으로 다시 열립니다',self.page.get_by_role('status').inner_text())
        self.assertTrue(restart.is_disabled())
        self.assertTrue(self.page.locator('#cdx-label-settings input[name="name"]').is_disabled())

    def test_downloaded_update_blocks_restart_until_label_edits_saved_or_cancelled(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.pendingUpdate=false;fixture.restarts=0;
            codexLabels.updateStatus=async()=>({currentVersion:'0.2.0',downloadedVersion:fixture.pendingUpdate?'0.3.0':'0.2.0',pendingRestart:fixture.pendingUpdate});
            codexLabels.checkUpdate=async()=>({currentVersion:'0.2.0',latestVersion:'0.3.0',available:true});
            codexLabels.stageUpdate=async()=>{fixture.pendingUpdate=true;return {currentVersion:'0.2.0',downloadedVersion:'0.3.0',pendingRestart:true};};
            codexLabels.restartUpdate=async()=>{fixture.restarts++;return {restarting:true};};
        }''')
        self.choose('라벨 설정…')
        name=self.page.locator('#cdx-label-settings input[name="name"]')
        original=name.input_value()
        name.fill('편집한 이름')
        self.page.get_by_text('Codex Labels 업데이트',exact=True).click()
        self.page.get_by_role('button',name='업데이트 확인',exact=True).click()
        self.page.get_by_role('button',name='다운로드 및 다음 실행에 적용',exact=True).click()
        restart=self.page.get_by_role('button',name='설치하고 다시 실행',exact=True)
        self.assertTrue(restart.is_disabled())
        self.assertIn('먼저 저장하거나 취소',self.page.locator('#cdx-label-settings').inner_text())
        self.assertEqual(name.input_value(),'편집한 이름')
        name.fill(original)
        self.assertTrue(restart.is_enabled())
        name.fill('저장한 이름')
        self.page.get_by_role('button',name='저장',exact=True).click()
        self.page.locator('#cdx-label-settings').wait_for(state='detached')
        self.choose('라벨 설정…')
        self.assertEqual(name.input_value(),'저장한 이름')
        self.assertTrue(restart.is_enabled())
        self.page.get_by_role('button',name='＋ 라벨 추가',exact=True).click()
        self.assertTrue(restart.is_disabled())
        self.page.get_by_role('button',name='취소',exact=True).click()
        self.choose('라벨 설정…')
        self.assertTrue(restart.is_enabled())
        self.assertEqual(self.page.evaluate('fixture.data.config.labels.length'),5)
        self.assertEqual(self.page.evaluate('fixture.restarts'),0)

    def test_rollback_is_explicit_and_disabled_while_label_draft_is_dirty(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.rollbacks=0;
            codexLabels.updateStatus=async()=>({currentVersion:'0.2.4',rollbackAvailable:true,recoveryNotice:'이전 버전 복구 가능'});
            codexLabels.checkUpdate=async()=>({currentVersion:'0.2.4',latestVersion:'0.2.4',available:false});
            codexLabels.stageUpdate=async()=>{throw Error('must not download');};
            codexLabels.rollbackUpdate=async()=>{fixture.rollbacks++;return {restarting:true};};
        }''')
        self.choose('라벨 설정…')
        button=self.page.get_by_role('button',name='이전 버전으로 돌아가기',exact=True)
        self.assertTrue(button.is_enabled())
        name=self.page.locator('#cdx-label-settings input[name="name"]')
        original=name.input_value();name.fill('아직 저장하지 않음')
        self.assertTrue(button.is_disabled())
        name.fill(original);button.click()
        self.assertEqual(self.page.evaluate('fixture.rollbacks'),1)
        self.assertIn('이전 버전으로 돌아갑니다',self.page.get_by_role('status').inner_text())
        self.assertEqual(self.page.evaluate('fixture.saves.length'),0)

    def test_restart_failure_retains_download_and_allows_retry(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.restarts=0;
            codexLabels.updateStatus=async()=>({currentVersion:'0.2.0',downloadedVersion:'0.3.0',pendingRestart:true});
            codexLabels.checkUpdate=async()=>{throw Error('unexpected check');};
            codexLabels.stageUpdate=async()=>{throw Error('already downloaded');};
            codexLabels.restartUpdate=async()=>{if(++fixture.restarts===1)throw Error('설치 도구를 시작하지 못했습니다.');return {restarting:true};};
        }''')
        self.choose('라벨 설정…')
        restart=self.page.get_by_role('button',name='설치하고 다시 실행',exact=True)
        restart.click()
        self.assertIn('다시 시도',self.page.get_by_role('status').inner_text())
        self.assertTrue(restart.is_enabled())
        self.assertTrue(self.page.locator('#cdx-label-settings input[name="name"]').is_enabled())
        self.assertIn('실행 중: v0.2.0 · 다운로드된 버전: v0.3.0',self.page.locator('#cdx-label-settings').inner_text())
        restart.click()
        self.assertEqual(self.page.evaluate('fixture.restarts'),2)

    def test_local_status_error_keeps_manual_check_and_unknown_running_version_distinct(self):
        self.start()
        self.page.evaluate('''()=>{
            fixture.updateCalls=[];
            codexLabels.updateStatus=async()=>{fixture.updateCalls.push('status');throw Error('상태 파일을 읽지 못했습니다.');};
            codexLabels.checkUpdate=async()=>{fixture.updateCalls.push('check');return {currentVersion:null,downloadedVersion:'0.3.0',pendingRestart:true};};
            codexLabels.stageUpdate=async()=>{throw Error('already downloaded');};
            codexLabels.restartUpdate=async()=>({restarting:true});
        }''')
        self.choose('라벨 설정…')
        check=self.page.get_by_role('button',name='업데이트 확인',exact=True)
        self.assertTrue(check.is_enabled())
        self.assertEqual(self.page.evaluate('fixture.updateCalls'),['status','check'])
        self.assertIn('실행 중: 버전 확인 불가 · 다운로드된 버전: v0.3.0',self.page.locator('#cdx-label-settings').inner_text())
        self.assertTrue(self.page.get_by_role('button',name='설치하고 다시 실행',exact=True).is_enabled())

    def test_add_multiple_labels_then_cancel_does_not_save(self):
        self.start();self.choose('라벨 설정…')
        for _ in range(2): self.page.get_by_role('button',name='＋ 라벨 추가',exact=True).click()
        self.assertEqual(self.page.locator('.cdx-settings-nav [aria-pressed]').count(),7)
        self.page.get_by_role('button',name='취소',exact=True).click()
        self.assertEqual(self.page.evaluate('fixture.saves.length'),0)
        self.choose('라벨 설정…')
        self.assertEqual(self.page.locator('.cdx-settings-nav [aria-pressed]').count(),5)

    def test_add_first_label_to_empty_config_and_limit_at_100(self):
        self.start("addRow('first');fixture.data.config.labels=[];")
        self.choose('라벨 설정…')
        self.page.get_by_role('button',name='＋ 라벨 추가',exact=True).click()
        self.assertEqual(self.page.locator('#cdx-label-settings input[name="name"]').input_value(),'새 라벨')
        self.page.get_by_role('button',name='취소',exact=True).click()
        self.page.evaluate('''()=>{const label={id:'first',name:'기본',backgroundColor:'#112233',textColor:'#FFFFFF',enabled:true,order:0,description:''};fixture.data.config.labels=Array.from({length:100},(_,i)=>({...label,id:'label_'+i}));fixture.advance(true);fixture.emit();}''')
        self.settle();self.choose('라벨 설정…')
        self.assertTrue(self.page.get_by_role('button',name='＋ 라벨 추가',exact=True).is_disabled())

    def test_config_event_preserves_settings_draft_and_applies_to_all_badges(self):
        self.start("""addRow('first'); addRow('second'); fixture.assign({
            'thread:local:local:first': 'requested', 'thread:local:local:second': 'requested'}, false);""")
        self.choose('라벨 설정…')
        draft = self.page.locator('#cdx-label-settings input[name="name"]')
        draft.fill('작성 중인 이름')
        self.page.evaluate("""() => {
            const label = fixture.data.config.labels[0]; label.name = '외부 변경';
            label.backgroundColor = '#123456'; fixture.advance(true); fixture.emit();
        }""")
        self.page.wait_for_function("document.querySelector('#first .cdx-label').textContent === '외부 변경'")
        self.assertEqual(self.badge('second').inner_text(), '외부 변경')
        self.assertEqual(self.badge().evaluate('(node) => getComputedStyle(node).backgroundColor'), 'rgb(18, 52, 86)')
        self.assertEqual(draft.input_value(), '작성 중인 이름')
        self.assertTrue(self.page.get_by_role('button', name='저장', exact=True).is_disabled())
        self.page.get_by_role('button', name='파일 설정 다시 불러오기').click()
        self.assertEqual(draft.input_value(), '외부 변경')
        draft.fill('새 이름')
        self.page.get_by_role('button', name='저장', exact=True).click()
        self.page.locator('#cdx-label-settings').wait_for(state='detached')
        self.settle()
        self.assertEqual(self.badge().inner_text(), '새 이름')
        self.assertEqual(self.badge('second').inner_text(), '새 이름')
        self.assertEqual(self.page.evaluate('fixture.saves.length'), 1)

    def test_change_during_read_is_not_lost_and_reads_stay_single_flight(self):
        self.start()
        self.page.evaluate("() => { fixture.nextReadHeld = true; window.dispatchEvent(new Event('focus')); }")
        self.page.wait_for_function('typeof fixture.releaseRead === "function"')
        self.page.evaluate("""() => {
            fixture.assign({'thread:local:local:first': 'completed'});
            fixture.emit(); fixture.emit(); fixture.releaseRead();
        }""")
        self.page.wait_for_function("document.querySelector('#first .cdx-label').textContent === '완료'")
        self.assertEqual(self.page.evaluate('fixture.maxActiveReads'), 1)

    def test_change_during_assignment_is_not_lost(self):
        self.start()
        self.page.evaluate('fixture.nextAssignHeld = true')
        self.choose('진행')
        self.page.wait_for_function('typeof fixture.releaseAssign === "function"')
        self.page.evaluate("""() => {
            fixture.assign({'thread:local:local:second': 'on_hold'});
            fixture.releaseAssign();
        }""")
        self.page.wait_for_function("document.querySelector('#second .cdx-label').textContent === '보류'")
        self.assertEqual(self.badge().inner_text(), '진행')

    def test_settings_open_serializes_with_background_read_and_uses_latest_config(self):
        self.start()
        self.page.evaluate("() => { fixture.nextReadHeld = true; window.dispatchEvent(new Event('focus')); }")
        self.page.wait_for_function('typeof fixture.releaseRead === "function"')
        self.page.evaluate("""() => {
            fixture.data.config.labels[0].name = '새 설정';
            fixture.advance(true); fixture.emit();
        }""")
        self.choose('라벨 설정…')
        self.assertEqual(self.page.evaluate('fixture.maxActiveReads'), 1)
        self.page.evaluate('fixture.releaseRead()')
        self.page.locator('#cdx-label-settings').wait_for()
        self.assertEqual(self.page.locator('#cdx-label-settings input[name="name"]').input_value(), '새 설정')
        self.assertEqual(self.page.evaluate('fixture.maxActiveReads'), 1)
        self.assertFalse(self.page.get_by_role('button', name='저장', exact=True).is_disabled())

    def test_older_background_read_cannot_revert_successful_assignment(self):
        self.start()
        self.page.evaluate("""() => {
            fixture.assign({'thread:local:local:first': 'requested'}, false);
            fixture.nextReadHeld = true; window.dispatchEvent(new Event('focus'));
        }""")
        self.page.wait_for_function('typeof fixture.releaseRead === "function"')
        self.choose('진행')
        self.assertEqual(self.badge().inner_text(), '진행')
        self.page.evaluate('fixture.releaseRead()')
        self.settle()
        self.assertEqual(self.badge().inner_text(), '진행')
        self.assertEqual(self.page.evaluate('fixture.maxActiveReads'), 1)

    def test_fallback_is_slow_and_pagehide_cleans_up_subscriptions_and_timer(self):
        self.page.clock.install()
        self.start()
        initial_reads = self.page.evaluate('fixture.reads.length')
        self.page.clock.fast_forward(20000)
        self.assertEqual(self.page.evaluate('fixture.reads.length'), initial_reads)
        self.page.clock.fast_forward(11000)
        self.assertGreater(self.page.evaluate('fixture.reads.length'), initial_reads)
        self.page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        after_cleanup = self.page.evaluate('fixture.reads.length')
        self.page.evaluate("""() => {
            fixture.assign({'thread:local:local:first': 'completed'});
            window.dispatchEvent(new Event('focus')); addRow('after-close');
        }""")
        self.page.clock.fast_forward(60000)
        self.assertEqual(self.page.evaluate('fixture.unsubscribed'), 1)
        self.assertEqual(self.page.evaluate('fixture.reads.length'), after_cleanup)
        self.assertEqual(self.badge('after-close').count(), 0)


if __name__ == '__main__':
    unittest.main()
