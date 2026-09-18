"""Chromium UI checks on the observed native selection-toolbar DOM contract."""
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'Browser tests are opt-in')
class VocabularyRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.driver = sync_playwright().start()
        cls.browser = cls.driver.chromium.launch(headless=True, executable_path=os.environ.get('CODEX_LABELS_CHROMIUM'))
        cls.source = (ROOT/'extension/vocabulary-renderer.js').read_text(encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.driver.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width': 1080, 'height': 760})
        self.page.set_default_timeout(4000)
        self.addCleanup(self.page.close)
        self.page.set_content('''<!doctype html><html><body style="font:16px/1.8 sans-serif;padding:90px;background:#f5f5f5">
          <div data-selected-text-overlay-target><p id="answer">글자를 선택하면 플로팅 툴바가 선택한 글자 근처에 나타납니다.</p></div>
          <div role="presentation" class="pointer-events-auto flex w-fit" style="display:flex;gap:6px;background:white;border:1px solid #ccc;padding:5px;width:fit-content;border-radius:10px">
            <button onclick="window.nativeClicks++" style="padding:8px;border:0;background:transparent">채팅에 추가</button>
            <button>사이드 채팅에 질문하기</button>
          </div><p id="outside">선택 범위 밖의 글자</p><textarea>입력 중인 단어</textarea></body></html>''')
        self.page.evaluate('''() => {
          window.nativeClicks=0;window.fixture={entries:[],revision:'1',summaries:[],hold:false,cancelled:0};
          const copy=x=>JSON.parse(JSON.stringify(x));
          window.codexLabels={
            vocabularyRead:async()=>({entries:copy(fixture.entries),revision:fixture.revision}),
            vocabularySummarize:async input=>{
              fixture.summaries.push(input);
              const draft={id:'draft-1',...input,meaning:'글자를 선택했을 때 선택한 글자 근처에 떠서 나타나는 도구 모음입니다.',example:'글자를 드래그하면 플로팅 툴바에서 복사할 수 있습니다.'};
              if(fixture.fail)throw Error('연결 실패');
              if(fixture.hold)return await new Promise(resolve=>{fixture.resolve=()=>resolve(draft);});
              return draft;
            },
            vocabularyCancel:async()=>{fixture.cancelled++;},
            vocabularySave:async(id,revision)=>{if(revision!==fixture.revision)throw Error('다른 창에서 변경');fixture.entries=[{id:'saved-1',...fixture.summaries.at(-1),meaning:'선택한 글자 근처에 나타나는 도구 모음',example:'단어장 버튼을 누릅니다.'}];fixture.revision=String(+fixture.revision+1);return {entries:copy(fixture.entries),revision:fixture.revision};},
            vocabularyDelete:async(id,revision)=>{if(revision!==fixture.revision)throw Error('다른 창에서 변경');fixture.entries=fixture.entries.filter(e=>e.id!==id);fixture.revision=String(+fixture.revision+1);return {entries:copy(fixture.entries),revision:fixture.revision};}
          };
        }''')
        self.page.evaluate(self.source)

    def select(self, selector='#answer', text='플로팅 툴바'):
        self.page.evaluate('''({selector,text})=>{const node=document.querySelector(selector).firstChild,range=document.createRange(),offset=node.textContent.indexOf(text);range.setStart(node,offset);range.setEnd(node,offset+text.length);const s=getSelection();s.removeAllRanges();s.addRange(range);}''', {'selector': selector, 'text': text})

    def open_selected(self):
        self.select()
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.get_by_role('dialog', name='단어장').wait_for()

    def test_selection_summary_save_search_reopen_delete(self):
        self.open_selected()
        self.page.get_by_role('button', name='단어장에 저장', exact=True).click()
        self.assertEqual(self.page.evaluate('nativeClicks'), 0)
        self.assertEqual(self.page.evaluate('fixture.summaries[0].term'), '플로팅 툴바')
        self.assertIn('글자를 선택하면', self.page.evaluate('fixture.summaries[0].context'))
        self.page.get_by_role('button', name='단어장 닫기').click()
        self.page.evaluate("dispatchEvent(new Event('codex-labels:open-vocabulary'))")
        self.page.locator('.vb-card').wait_for()
        self.page.get_by_role('searchbox', name='저장한 단어 검색').fill('없는 단어')
        self.assertEqual(self.page.locator('.vb-card').count(), 0)
        self.page.get_by_role('searchbox', name='저장한 단어 검색').fill('')
        delete=self.page.get_by_role('button', name='플로팅 툴바 삭제')
        delete.click()
        self.assertEqual(self.page.evaluate('fixture.entries.length'), 1)
        delete.click()
        self.page.wait_for_function('fixture.entries.length===0')

    def test_selection_outside_response_and_long_selection_do_not_show_button(self):
        self.select('#outside', '선택 범위')
        self.page.wait_for_timeout(60)
        self.assertEqual(self.page.locator('.cdx-vocabulary-action').count(), 0)
        self.page.locator('#answer').evaluate("n=>n.textContent='a'.repeat(161)")
        self.select('#answer', 'a'*161)
        self.page.wait_for_timeout(60)
        self.assertEqual(self.page.locator('.cdx-vocabulary-action').count(), 0)

    def test_rerender_does_not_duplicate_button_and_native_action_still_works(self):
        self.select()
        self.page.locator('.cdx-vocabulary-action').wait_for()
        self.page.evaluate("document.querySelector('[role=presentation]').append(document.createElement('span'))")
        self.page.wait_for_timeout(60)
        self.assertEqual(self.page.locator('.cdx-vocabulary-action').count(), 1)
        self.page.get_by_role('button', name='채팅에 추가', exact=True).click()
        self.assertEqual(self.page.evaluate('nativeClicks'), 1)

    def test_closed_dialog_does_not_accept_late_result(self):
        self.page.evaluate('fixture.hold=true')
        self.open_selected()
        self.page.wait_for_function('fixture.resolve!==undefined')
        self.page.get_by_role('button', name='단어장 닫기').click()
        self.page.evaluate('fixture.resolve()')
        self.page.wait_for_timeout(60)
        self.assertEqual(self.page.locator('#cdx-vocabulary').count(), 0)
        self.assertEqual(self.page.evaluate('fixture.entries.length'), 0)

    def test_failure_disables_save_and_retry_recovers(self):
        self.page.evaluate('fixture.fail=true')
        self.open_selected()
        self.page.get_by_text('연결 실패', exact=True).wait_for()
        self.assertTrue(self.page.get_by_role('button', name='단어장에 저장', exact=True).is_disabled())
        self.page.evaluate('fixture.fail=false')
        self.page.get_by_role('button', name='다시 요약').click()
        self.page.wait_for_function("!document.querySelector('.vb-primary').disabled")

    def test_model_text_is_plain_text_and_mobile_dialog_fits(self):
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.evaluate("codexLabels.vocabularySummarize=async input=>({id:'x',...input,meaning:'<img src=x onerror=alert(1)>',example:''})")
        self.open_selected()
        self.page.get_by_text('<img src=x onerror=alert(1)>', exact=True).wait_for()
        self.assertEqual(self.page.locator('#cdx-vocabulary img').count(),0)
        self.assertLessEqual(self.page.locator('#cdx-vocabulary').bounding_box()['width'],390)

    def test_visual_capture_light_and_dark(self):
        self.select()
        self.page.locator('.cdx-vocabulary-action').wait_for()
        output=os.environ.get('CODEX_LABELS_VOCABULARY_ARTIFACTS')
        if output:
            Path(output).mkdir(parents=True,exist_ok=True)
            self.page.screenshot(path=str(Path(output)/'selection-toolbar.png'))
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function("!document.querySelector('.vb-primary').disabled")
        if output:
            self.page.screenshot(path=str(Path(output)/'vocabulary-light.png'))
            self.page.evaluate("document.documentElement.classList.add('dark')")
            self.page.screenshot(path=str(Path(output)/'vocabulary-dark.png'))


if __name__ == '__main__':
    unittest.main()
