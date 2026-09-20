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

    def test_vocabulary_action_has_visible_separator_from_native_action(self):
        self.select()
        separator = self.page.locator('.cdx-vocabulary-action').evaluate('''node => {
          const style = getComputedStyle(node, '::before');
          return {content: style.content, width: style.width, background: style.backgroundColor, opacity: style.opacity};
        }''')
        self.assertEqual(separator['content'], '""')
        self.assertEqual(separator['width'], '1px')
        self.assertNotEqual(separator['background'], 'rgba(0, 0, 0, 0)')
        self.assertEqual(separator['opacity'], '0.34')

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
              const draft={id:'draft-'+fixture.summaries.length,...input,meaning:fixture.meaning||'글자를 선택했을 때 선택한 글자 근처에 떠서 나타나는 도구 모음입니다.',example:'글자를 드래그하면 플로팅 툴바에서 복사할 수 있습니다.',partOfSpeech:'명사',explanation:'문맥에 따라 달라지는 도구 모음입니다.',tags:['UI/UX'],status:'new',favorite:false};fixture.draft=draft;
              if(fixture.fail)throw Error('연결 실패');
              if(fixture.hold)return await new Promise(resolve=>{fixture.resolve=()=>resolve(draft);});
              return draft;
            },
            vocabularyCancel:async()=>{fixture.cancelled++;},
            vocabularySave:async(id,revision,options)=>{if(revision!==fixture.revision)throw Error('다른 창에서 변경');fixture.entries.unshift({...fixture.draft,...options.edits});fixture.revision=String(+fixture.revision+1);return {entries:copy(fixture.entries),revision:fixture.revision};},
            vocabularyEdit:async(id,patch,revision)=>{if(revision!==fixture.revision)throw Error('다른 창에서 변경');fixture.entries=fixture.entries.map(e=>e.id===id?{...e,...patch}:e);fixture.revision=String(+fixture.revision+1);return {entries:copy(fixture.entries),revision:fixture.revision};},
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

    def test_context_uses_selected_occurrence_not_first_text_match(self):
        self.page.evaluate("""() => {
          const node=document.querySelector('#answer').firstChild;
          node.textContent='FIRST_MEANING bank. '+'earlier text '.repeat(180)+'SECOND_MEANING bank by the river.';
          const offset=node.textContent.lastIndexOf('bank'),range=document.createRange();
          range.setStart(node,offset);range.setEnd(node,offset+4);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        }""")
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function('fixture.summaries.length===1')
        result=self.page.evaluate('fixture.summaries[0]')
        self.assertEqual(result['term'], 'bank')
        self.assertTrue('SECOND_MEANING bank by the river.' in result['context'])
        self.assertNotIn('FIRST_MEANING', result['context'])
        self.assertLessEqual(len(result['context']), 1600)

    def test_context_tracks_phrase_across_inline_nodes(self):
        self.page.evaluate("""() => {
          const answer=document.querySelector('#answer');
          answer.replaceChildren(document.createTextNode('FIRST_MEANING race condition. '+'earlier text '.repeat(180)));
          const prefix=document.createElement('span');prefix.textContent='SECOND_MEANING ';
          const first=document.createElement('strong');first.textContent='race ';
          const last=document.createElement('code');last.textContent='condition';
          answer.append(prefix,first,last,document.createTextNode(' in concurrent code.'));
          const range=document.createRange();range.setStart(first.firstChild,0);range.setEnd(last.firstChild,9);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        }""")
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function('fixture.summaries.length===1')
        result=self.page.evaluate('fixture.summaries[0]')
        self.assertEqual(result['term'], 'race condition')
        self.assertTrue('SECOND_MEANING race condition in concurrent code.' in result['context'])
        self.assertNotIn('FIRST_MEANING', result['context'])

    def test_context_retains_160_character_selection_with_bounded_payload(self):
        self.page.evaluate("""() => {
          const node=document.querySelector('#answer').firstChild;
          const prefix='before '.repeat(400),term='x'.repeat(160);
          node.textContent=prefix+term+' after'.repeat(400);
          const range=document.createRange();range.setStart(node,prefix.length);range.setEnd(node,prefix.length+term.length);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        }""")
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function('fixture.summaries.length===1')
        result=self.page.evaluate('fixture.summaries[0]')
        self.assertEqual(result['term'], 'x'*160)
        self.assertIn(result['term'], result['context'])
        self.assertLessEqual(len(result['context']), 1600)
        self.assertIn('before', result['context'])
        self.assertIn('after', result['context'])

    def test_context_centers_trimmed_selection_after_long_leading_whitespace(self):
        self.page.evaluate("""() => {
          const answer=document.querySelector('#answer');answer.style.whiteSpace='pre-wrap';
          const prefix='FIRST_MEANING bank. ',padding=' '.repeat(2200),node=answer.firstChild;
          node.textContent=prefix+padding+'bank SECOND_MEANING';
          const range=document.createRange();range.setStart(node,prefix.length);range.setEnd(node,prefix.length+padding.length+4);
          const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
        }""")
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function('fixture.summaries.length===1')
        result=self.page.evaluate('fixture.summaries[0]')
        self.assertEqual(result['term'], 'bank')
        self.assertTrue('bank SECOND_MEANING' in result['context'])
        self.assertNotIn('FIRST_MEANING', result['context'])
        self.assertLessEqual(len(result['context']), 1600)

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


    def save_first(self):
        self.open_selected()
        self.page.get_by_role('button', name='단어장에 저장', exact=True).click()
        self.page.wait_for_function('fixture.entries.length===1')

    def test_preview_edits_and_later_edits_preserve_context_without_ai(self):
        self.open_selected()
        self.page.get_by_role('button', name='뜻 편집', exact=True).click()
        self.page.get_by_label('문맥상 뜻', exact=True).fill('내가 고친 문맥상 뜻')
        self.page.get_by_label('예문', exact=True).fill('내 예문')
        self.page.get_by_label('학습 상태', exact=True).select_option('review')
        self.page.get_by_role('button', name='단어장에 저장', exact=True).click()
        self.page.wait_for_function("fixture.entries[0]?.meaning==='내가 고친 문맥상 뜻'")
        context=self.page.evaluate('fixture.entries[0].context')
        self.page.get_by_role('button', name='뜻 편집', exact=True).click()
        self.page.get_by_label('문맥상 뜻', exact=True).fill('나중에 수정한 뜻')
        self.page.get_by_role('button', name='수정 저장', exact=True).click()
        self.page.wait_for_function("fixture.entries[0].meaning==='나중에 수정한 뜻'")
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),1)
        self.assertEqual(self.page.evaluate('fixture.entries[0].context'),context)
        self.assertEqual(self.page.evaluate('fixture.entries[0].status'),'review')

    def test_saved_badge_reuses_definition_and_new_meaning_does_not_replace_it(self):
        self.save_first()
        original=self.page.evaluate('fixture.entries[0].meaning')
        self.page.get_by_role('button', name='단어장 닫기').click()
        self.select()
        self.page.get_by_role('button',name='✓ 단어장',exact=True).click()
        self.page.get_by_role('button',name='새 의미 추가',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),1)
        self.page.evaluate("fixture.meaning='다른 문맥에서의 두 번째 뜻'")
        self.page.get_by_role('button',name='새 의미 추가',exact=True).click()
        self.page.get_by_role('button',name='단어장에 저장',exact=True).click()
        self.page.wait_for_function('fixture.entries.length===2')
        self.assertEqual(self.page.evaluate('fixture.entries[1].meaning'),original)

    def test_library_filters_tags_context_favorites_and_status(self):
        self.save_first()
        self.page.get_by_role('button',name='플로팅 툴바 즐겨찾기').click()
        self.page.wait_for_function('fixture.entries[0].favorite===true')
        self.page.get_by_label('즐겨찾기만',exact=True).check()
        search=self.page.get_by_role('searchbox',name='저장한 단어 검색')
        search.fill('ＵＩ/ＵＸ')
        self.assertEqual(self.page.locator('.vb-card').count(),1)
        search.fill('글자를 선택하면')
        self.assertEqual(self.page.locator('.vb-card').count(),1)
        self.page.get_by_label('학습 상태 필터').select_option('known')
        self.assertEqual(self.page.locator('.vb-card').count(),0)
        self.page.get_by_label('학습 상태 필터').select_option('new')
        self.assertEqual(self.page.locator('.vb-card').count(),1)

    def test_selection_uses_actual_occurrence_and_retains_local_title(self):
        self.page.evaluate("document.title='테스트 대화';document.querySelector('#answer').textContent='TERM '+ 'x'.repeat(1800)+' SECOND_CONTEXT TERM'")
        self.page.evaluate("""()=>{const node=document.querySelector('#answer').firstChild,r=document.createRange(),i=node.textContent.lastIndexOf('TERM');r.setStart(node,i);r.setEnd(node,i+4);getSelection().removeAllRanges();getSelection().addRange(r);} """)
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.wait_for_function('fixture.summaries.length===1')
        data=self.page.evaluate('fixture.summaries[0]')
        self.assertIn('SECOND_CONTEXT',data['context'])
        self.assertLessEqual(len(data['context']),1600)
        self.assertEqual(data['source']['title'],'테스트 대화')

    def test_cancelled_late_result_cannot_enable_save(self):
        self.page.evaluate('fixture.hold=true')
        self.open_selected()
        self.page.wait_for_function('fixture.resolve!==undefined')
        self.page.get_by_role('button',name='요약 취소',exact=True).click()
        self.page.evaluate('fixture.resolve()')
        self.page.wait_for_function("document.querySelector('.vb-primary').disabled")
        self.assertEqual(self.page.evaluate('fixture.entries.length'),0)
        self.assertTrue(self.page.get_by_role('button',name='단어장에 저장',exact=True).is_disabled())

    def test_unsaved_edits_survive_refresh_and_conflict(self):
        self.save_first()
        self.page.get_by_role('button',name='뜻 편집',exact=True).click()
        self.page.get_by_label('문맥상 뜻',exact=True).fill('아직 저장하지 않은 뜻')
        self.page.get_by_role('button',name='새로고침',exact=True).click()
        self.assertEqual(self.page.get_by_label('문맥상 뜻',exact=True).input_value(),'아직 저장하지 않은 뜻')
        self.page.evaluate("fixture.revision='99';fixture.entries[0].meaning='다른 창에서 고친 뜻'")
        self.page.get_by_role('button',name='수정 저장',exact=True).click()
        self.page.get_by_text('다른 창에서 변경',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.entries[0].meaning'),'다른 창에서 고친 뜻')
        self.assertEqual(self.page.get_by_label('문맥상 뜻',exact=True).input_value(),'아직 저장하지 않은 뜻')

    def test_discard_confirmation_protects_unsaved_edit_on_close(self):
        self.save_first()
        self.page.get_by_role('button',name='뜻 편집',exact=True).click()
        self.page.get_by_label('문맥상 뜻',exact=True).fill('저장 전 수정')
        self.page.once('dialog',lambda dialog:dialog.dismiss())
        self.page.get_by_role('button',name='단어장 닫기').click()
        self.assertEqual(self.page.locator('#cdx-vocabulary').count(),1)
        self.page.once('dialog',lambda dialog:dialog.accept())
        self.page.get_by_role('button',name='단어장 닫기').click()
        self.assertEqual(self.page.locator('#cdx-vocabulary').count(),0)


    def test_old_pending_badge_read_does_not_erase_newer_saved_state(self):
        self.page.evaluate("""() => {
          const read=codexLabels.vocabularyRead;let calls=0;
          codexLabels.vocabularyRead=()=>calls++===0?new Promise(resolve=>{fixture.oldRead=()=>resolve({entries:[],revision:'1'});}):read();
        }""")
        self.save_first()
        self.page.evaluate('fixture.oldRead()')
        self.page.get_by_role('button',name='단어장 닫기').click()
        self.select()
        self.page.get_by_role('button',name='✓ 단어장',exact=True).wait_for()


if __name__ == '__main__':
    unittest.main()
