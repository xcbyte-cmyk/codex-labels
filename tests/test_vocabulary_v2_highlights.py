"""Real Chromium: non-mutating vocabulary highlights with mocked native IPC."""
import os
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
NAME = 'codex-vocabulary-saved'


def item(term='bank', meaning='은행', id='one'):
    return dict(id=id, term=term, meaning=meaning, context='Original bank context.',
                partOfSpeech='명사', example='The bank is open.', explanation='저장된 문맥의 뜻입니다.',
                tags=['일반 영어'], favorite=False, status='new')


@unittest.skipUnless(os.environ.get('CODEX_LABELS_BROWSER_TESTS') == '1', 'Browser tests are opt-in')
class VocabularyHighlightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.driver = sync_playwright().start()
        cls.browser = cls.driver.chromium.launch(headless=True, executable_path=os.environ.get('CODEX_LABELS_CHROMIUM'))
        cls.source = (ROOT/'extension/vocabulary-v2-renderer.js').read_text(encoding='utf-8')

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.driver.stop()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':1080, 'height':800})
        self.page.set_default_timeout(3000)
        self.errors=[]
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.addCleanup(self.page.close)
        self.page.set_content('''<!doctype html><html><head><title>단어장 대화</title></head>
        <body style="font:18px/2 sans-serif;padding:72px;background:#f5f6f7">
          <main id="thread"><section data-selected-text-overlay-target><p id="answer">The bank is open. Visit the bank.</p></section></main>
          <div role="presentation" class="pointer-events-auto" style="display:flex;gap:6px;padding:6px;border:1px solid #bbb;width:fit-content">
           <button onclick="fixture.nativeClicks++">채팅에 추가</button><button>사이드 채팅에 질문하기</button>
          </div>
          <p id="outside">bank outside conversation</p><textarea id="composer">bank typed here</textarea>
        </body></html>''')
        self.page.evaluate('''() => {
          const copy=x=>JSON.parse(JSON.stringify(x));
          window.fixture={entries:[],revision:'1',listeners:new Set(),reads:0,summaries:[],nativeClicks:0,cancelled:0};
          fixture.emit=()=>{for(const f of fixture.listeners)f();};
          fixture.push=entries=>{fixture.entries=copy(entries);fixture.revision=String(+fixture.revision+1);fixture.emit();};
          window.codexLabels={
            vocabularyRead:async()=>{
              fixture.reads++;const data={entries:copy(fixture.entries),revision:fixture.revision};
              if(fixture.failRead)throw Error('읽기 실패');
              if(fixture.holdRead){fixture.holdRead=false;return new Promise(r=>fixture.resolveRead=()=>r(data));}
              return data;
            },
            onVocabularyChanged:callback=>{fixture.listeners.add(callback);return ()=>fixture.listeners.delete(callback);},
            vocabularySummarize:async input=>{
              fixture.summaries.push(input);
              fixture.draft={id:'draft-1',...input,meaning:'새로 저장한 은행',example:'The bank is open.',partOfSpeech:'명사',tags:['일반 영어'],status:'new',favorite:false};
              return copy(fixture.draft);
            },
            vocabularyCancel:async()=>{fixture.cancelled++;},
            vocabularySave:async(id,revision,options)=>{
              if(revision!==fixture.revision)throw Error('다른 창에서 변경되었습니다.');
              fixture.entries.unshift({...fixture.draft,...options.edits});fixture.revision=String(+fixture.revision+1);
              return {entries:copy(fixture.entries),revision:fixture.revision};
            },
            vocabularyEdit:async(id,patch,revision)=>{
              if(revision!==fixture.revision)throw Error('다른 창에서 변경되었습니다.');
              fixture.entries=fixture.entries.map(e=>e.id===id?{...e,...patch}:e);fixture.revision=String(+fixture.revision+1);
              return {entries:copy(fixture.entries),revision:fixture.revision};
            },
            vocabularyDelete:async(id,revision)=>{
              if(revision!==fixture.revision||fixture.conflict)throw Error('다른 창에서 변경되었습니다. 새로고침하세요.');
              fixture.entries=fixture.entries.filter(e=>e.id!==id);fixture.revision=String(+fixture.revision+1);
              return {entries:copy(fixture.entries),revision:fixture.revision};
            }
          };
          window.rangeText=r=>{const x=document.createRange();x.setStart(r.startContainer,r.startOffset);x.setEnd(r.endContainer,r.endOffset);return x.toString();};
          window.hits=()=>Array.from(CSS.highlights.get('codex-vocabulary-saved')||[],rangeText);
        }''')

    def load(self, entries=None, html=None):
        if html is not None:
            self.page.locator('#thread').evaluate('(n,html)=>n.innerHTML=html', html)
        self.page.evaluate('entries=>fixture.entries=entries', entries if entries is not None else [item()])
        self.page.evaluate(self.source)

    def wait_hits(self, count):
        self.page.wait_for_function('(count)=>hits().length===count', arg=count)

    def click_hit(self, index=0):
        rect=self.page.evaluate('''i=>{
          const s=Array.from(CSS.highlights.get('codex-vocabulary-saved'))[i];const r=document.createRange();
          r.setStart(s.startContainer,s.startOffset);r.setEnd(s.endContainer,s.endOffset);
          const b=r.getClientRects()[0];return {x:b.x+b.width/2,y:b.y+b.height/2};
        }''',index)
        self.page.mouse.click(rect['x'],rect['y'])
        self.page.get_by_role('dialog', name='저장된 단어 뜻', exact=True).wait_for()

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def test_all_occurrences_across_past_new_and_user_conversations(self):
        self.load();self.wait_hits(2)
        self.page.locator('#thread').evaluate('''n=>n.innerHTML='<section data-selected-text-overlay-target><p>bank in past chat.</p></section><section data-message-author-role="user"><p>My bank question.</p></section>' ''')
        self.wait_hits(2)
        self.assertEqual(self.page.evaluate('hits()'),['bank','bank'])
        self.page.locator('#thread').evaluate('''n=>n.innerHTML='<section data-selected-text-overlay-target><p>BANK in new chat.</p></section>' ''')
        self.wait_hits(1);self.assertEqual(self.page.evaluate('hits()'),['BANK'])
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),0)

    def test_streaming_text_append_and_replacement(self):
        self.load(html='<section data-selected-text-overlay-target><p id="answer">The ba</p></section>')
        self.page.wait_for_timeout(100);self.wait_hits(0)
        self.page.locator('#answer').evaluate("n=>n.firstChild.appendData('nk is open.')")
        self.wait_hits(1)
        self.page.locator('#answer').evaluate("n=>n.textContent='BANK then bank'")
        self.wait_hits(2)
        self.page.locator('#answer').evaluate("n=>n.textContent='bankruptcy only'")
        self.wait_hits(0)

    def test_existing_dom_text_nodes_and_selection_are_unchanged(self):
        self.page.evaluate("window.originalNode=document.querySelector('#answer').firstChild;window.originalMarkup=document.querySelector('#thread').innerHTML")
        self.load();self.wait_hits(2)
        self.assertTrue(self.page.evaluate("originalNode===document.querySelector('#answer').firstChild"))
        self.assertTrue(self.page.evaluate("originalMarkup===document.querySelector('#thread').innerHTML"))
        self.page.evaluate("const r=document.createRange();r.selectNodeContents(document.querySelector('#answer'));getSelection().removeAllRanges();getSelection().addRange(r)")
        self.assertEqual(self.page.evaluate('getSelection().toString()'),'The bank is open. Visit the bank.')
        self.assertEqual(self.page.locator('#thread mark, #thread button').count(),0)

    def test_longest_phrase_nfkc_whitespace_and_inline_nodes(self):
        entries=[item('account'),item('take into account',id='p'),item('race condition',id='r'),item('Popover',id='v')]
        self.load(entries, '<section data-selected-text-overlay-target><p>take <strong>into</strong>   account; account; <em>race </em><span>condition</span>; ＰＯＰＯＶＥＲ.</p></section>')
        self.wait_hits(4)
        self.assertEqual(self.page.evaluate('hits()'),['take into   account','account','race condition','ＰＯＰＯＶＥＲ'])

    def test_boundaries_do_not_match_inflections_or_identifiers(self):
        self.load([item('run'),item('bank',id='b')],'<section data-selected-text-overlay-target><p>running run RUN bank1 bank_bank bank.</p></section>')
        self.wait_hits(3);self.assertEqual(self.page.evaluate('hits()'),['run','RUN','bank'])

    def test_links_code_inputs_hidden_and_toolbars_are_excluded(self):
        self.load(html='''<section data-selected-text-overlay-target><p>bank <a id="link" href="#linked">bank</a><code>bank</code><kbd>bank</kbd><button>bank</button><span hidden>bank</span><span aria-hidden="true">bank</span><span contenteditable="">bank</span><span role="button">bank</span></p><pre>bank</pre><textarea>bank</textarea><input value="bank"><div role="toolbar">bank</div></section>''')
        self.wait_hits(1);self.assertEqual(self.page.evaluate('hits()'),['bank'])
        self.page.locator('#link').click();self.assertTrue(self.page.url.endswith('#linked'))
        self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_no_phrase_across_paragraphs_links_code_or_br(self):
        self.load([item('race condition')],'''<section data-selected-text-overlay-target><p>race</p><p>condition</p><p>race <code>ignored</code>condition</p><p>race <a href="#">ignored</a>condition</p><p>race<br>condition</p><p>race condition</p></section>''')
        self.wait_hits(1)

    def test_click_shows_all_saved_senses_and_never_calls_model(self):
        self.load([item(),item('ＢＡＮＫ','강둑','two')]);self.wait_hits(2);self.click_hit()
        self.assertEqual(self.page.locator('.vi-sense').count(),2)
        self.page.get_by_text('은행',exact=True).wait_for();self.page.get_by_text('강둑',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),0)

    def test_word_list_keyboard_enter_escape_and_focus_return(self):
        self.load();self.wait_hits(2)
        self.page.keyboard.press('Alt+Shift+V')
        popup=self.page.get_by_role('dialog',name='저장된 단어 뜻',exact=True);popup.wait_for()
        word=popup.get_by_role('button',name='bank · 1개 뜻',exact=True);word.focus();self.page.keyboard.press('Enter')
        self.page.get_by_text('은행',exact=True).wait_for();self.page.keyboard.press('Escape')
        self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)
        self.assertTrue(self.page.locator('#cdx-vocabulary-access').evaluate('n=>n===document.activeElement'))
        self.page.locator('#composer').focus();self.page.keyboard.press('Alt+Shift+V');self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_edit_link_opens_matching_entry_without_summarizing_and_updates_everywhere(self):
        self.load();self.wait_hits(2);self.click_hit()
        self.page.get_by_role('button',name='수정',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='단어장',exact=True);dialog.wait_for()
        dialog.get_by_label('문맥상 뜻',exact=True).fill('편집한 은행 뜻')
        dialog.get_by_role('button',name='수정 저장',exact=True).click()
        dialog.get_by_role('button',name='단어장 닫기',exact=True).click()
        self.wait_hits(2);self.click_hit(1);self.page.get_by_text('편집한 은행 뜻',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),0)

    def test_save_immediately_highlights_all_matching_occurrences(self):
        self.load([])
        self.page.evaluate('''() => {const n=document.querySelector('#answer').firstChild,r=document.createRange();r.setStart(n,4);r.setEnd(n,8);getSelection().removeAllRanges();getSelection().addRange(r);}''')
        self.page.locator('.cdx-vocabulary-action').click()
        self.page.get_by_role('button',name='단어장에 저장',exact=True).click()
        self.page.get_by_role('button',name='단어장 닫기',exact=True).click()
        self.wait_hits(2);self.click_hit();self.page.get_by_text('새로 저장한 은행',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.summaries.length'),1)

    def test_delete_requires_confirmation_and_removes_all_highlights(self):
        self.load();self.wait_hits(2);self.click_hit()
        delete=self.page.get_by_role('button',name='bank 뜻 삭제',exact=True)
        delete.click();self.assertEqual(self.page.evaluate('fixture.entries.length'),1);delete.click()
        self.wait_hits(0);self.assertEqual(self.page.evaluate('fixture.entries.length'),0)
        self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_deleting_one_of_multiple_senses_keeps_highlights_and_other_sense(self):
        self.load([item(),item('bank','강둑','two')]);self.wait_hits(2);self.click_hit()
        delete=self.page.get_by_role('button',name='bank 뜻 삭제').first
        delete.click();delete.click();self.page.wait_for_function('fixture.entries.length===1')
        self.wait_hits(2);self.assertEqual(self.page.locator('.vi-sense').count(),1)
        self.page.get_by_text('강둑',exact=True).wait_for()

    def test_external_window_notifications_refresh_add_edit_and_delete(self):
        self.load([]);self.page.wait_for_function('fixture.listeners.size===1')
        self.page.evaluate('entries=>fixture.push(entries)',[item()]);self.wait_hits(2);self.click_hit()
        self.page.evaluate('entries=>fixture.push(entries)',[item(meaning='외부 창 수정')]);self.page.get_by_text('외부 창 수정',exact=True).wait_for()
        self.page.evaluate('fixture.push([])');self.wait_hits(0)

    def test_stale_read_cannot_resurrect_a_deleted_word(self):
        self.load();self.wait_hits(2)
        self.page.evaluate('fixture.holdRead=true;fixture.emit()');self.page.wait_for_function('!!fixture.resolveRead')
        self.page.evaluate('fixture.push([]);fixture.resolveRead()');self.wait_hits(0)
        self.page.wait_for_timeout(150);self.assertEqual(self.page.evaluate('hits()'),[])

    def test_conflicting_delete_preserves_data_and_reports_error(self):
        self.load();self.wait_hits(2);self.click_hit();self.page.evaluate('fixture.conflict=true')
        delete=self.page.get_by_role('button',name='bank 뜻 삭제',exact=True);delete.click();delete.click()
        self.page.get_by_role('alert').wait_for();self.assertEqual(self.page.evaluate('fixture.entries.length'),1);self.wait_hits(2)

    def test_dom_re_render_does_not_duplicate_ranges_or_break_native_toolbar(self):
        self.load();self.wait_hits(2)
        self.page.locator('#answer').evaluate("n=>{for(let i=0;i<12;i++)n.textContent='The bank is open. Visit the bank.';}")
        self.wait_hits(2);self.page.wait_for_timeout(250);self.wait_hits(2)
        self.page.get_by_role('button',name='채팅에 추가',exact=True).click();self.assertEqual(self.page.evaluate('fixture.nativeClicks'),1)
        self.assertLess(self.page.evaluate('fixture.reads'),6)

    def test_text_drag_does_not_open_popup_or_change_selected_text(self):
        self.load();self.wait_hits(2)
        rect=self.page.locator('#answer').bounding_box()
        self.page.mouse.move(rect['x']+1,rect['y']+rect['height']/2);self.page.mouse.down();self.page.mouse.move(rect['x']+240,rect['y']+rect['height']/2,steps=12);self.page.mouse.up()
        self.assertTrue(self.page.evaluate('getSelection().toString().length>0'))
        self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_removed_thread_discards_ranges_and_closes_popup(self):
        self.load();self.wait_hits(2);self.click_hit();self.page.locator('#thread').evaluate('n=>n.replaceChildren()')
        self.wait_hits(0);self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_newly_visible_long_conversation_is_scanned_on_scroll(self):
        self.load(html='<section data-selected-text-overlay-target><p>bank first</p><div style="height:3000px"></div><p id="later">bank later</p></section>')
        self.wait_hits(1);self.page.locator('#later').scroll_into_view_if_needed();self.wait_hits(2)

    def test_changed_paragraph_does_not_replace_unchanged_paragraph_ranges(self):
        self.load(html='<section data-selected-text-overlay-target><p id="one">bank</p><p id="two">bank</p></section>');self.wait_hits(2)
        self.page.evaluate("window.firstHit=Array.from(CSS.highlights.get('codex-vocabulary-saved')).find(r=>r.startContainer.parentElement.id==='one')")
        self.page.locator('#two').evaluate("n=>n.firstChild.appendData(' bank')");self.wait_hits(3)
        self.assertTrue(self.page.evaluate("CSS.highlights.get('codex-vocabulary-saved').has(firstHit)"))

    def test_hidden_and_contenteditable_changes_remove_and_restore_marks(self):
        self.load();self.wait_hits(2)
        self.page.locator('#answer').evaluate('n=>n.hidden=true');self.wait_hits(0)
        self.page.locator('#answer').evaluate('n=>n.hidden=false');self.wait_hits(2)
        self.page.locator('#answer').evaluate("n=>n.contentEditable='true'");self.wait_hits(0)
        self.page.locator('#answer').evaluate("n=>n.removeAttribute('contenteditable')");self.wait_hits(2)

    def test_markup_in_saved_meaning_remains_literal_text(self):
        text='<img src=x onerror=alert(1)>'
        self.load([item(meaning=text)]);self.wait_hits(2);self.click_hit()
        self.page.get_by_text(text,exact=True).wait_for();self.assertEqual(self.page.locator('#cdx-vocabulary-inline img').count(),0)

    def test_pagehide_disposes_observers_callbacks_and_only_own_highlights(self):
        self.load();self.wait_hits(2)
        self.page.evaluate("CSS.highlights.set('other-feature',new Highlight());dispatchEvent(new Event('pagehide'))")
        self.assertFalse(self.page.evaluate("CSS.highlights.has('codex-vocabulary-saved')"))
        self.assertTrue(self.page.evaluate("CSS.highlights.has('other-feature')"))
        self.assertEqual(self.page.evaluate('fixture.listeners.size'),0)
        self.assertEqual(self.page.locator('#cdx-vocabulary-access').count(),0)
        self.page.evaluate('fixture.push([])');self.page.wait_for_timeout(80)

    def test_2000_terms_responsive_and_only_conversation_matches(self):
        entries=[item('term'+str(i),id=str(i)) for i in range(2000)]
        self.load(entries,'<section data-selected-text-overlay-target><p>term1999 and term42; notterm1.</p></section>')
        self.wait_hits(2);self.assertEqual(self.page.evaluate('hits()'),['term1999','term42'])
        self.page.locator('#composer').fill('still editable');self.assertEqual(self.page.locator('#composer').input_value(),'still editable')

    def test_unsupported_highlight_api_leaves_dom_and_dictionary_usable(self):
        self.page.evaluate('window.Highlight=undefined')
        self.load()
        self.page.locator('#cdx-vocabulary-access').click();self.page.get_by_role('dialog',name='단어장',exact=True).wait_for()
        self.assertEqual(self.page.evaluate('fixture.entries.length'),1)
        self.assertEqual(self.page.locator('#answer').text_content(),'The bank is open. Visit the bank.')

    def test_read_failure_recovers_on_focus_without_writing_data(self):
        self.page.evaluate('fixture.failRead=true');self.load();self.page.wait_for_timeout(100)
        self.wait_hits(0);self.page.evaluate('fixture.failRead=false;dispatchEvent(new Event("focus"))');self.wait_hits(2)
        self.assertEqual(self.page.evaluate('fixture.entries.length'),1)

    def test_double_click_still_selects_word_instead_of_opening_popup(self):
        self.load();self.wait_hits(2)
        rect=self.page.evaluate("""() => {const r=document.createRange();const s=Array.from(CSS.highlights.get('codex-vocabulary-saved'))[0];r.setStart(s.startContainer,s.startOffset);r.setEnd(s.endContainer,s.endOffset);const b=r.getClientRects()[0];return {x:b.x+b.width/2,y:b.y+b.height/2};}""")
        self.page.mouse.dblclick(rect['x'],rect['y']);self.page.wait_for_timeout(80)
        self.assertEqual(self.page.evaluate('getSelection().toString().trim()'),'bank')
        self.assertEqual(self.page.locator('#cdx-vocabulary-inline').count(),0)

    def test_role_change_to_interactive_removes_marks(self):
        self.load();self.wait_hits(2)
        self.page.locator('#answer').evaluate("n=>n.setAttribute('role','button')");self.wait_hits(0)
        self.page.locator('#answer').evaluate("n=>n.removeAttribute('role')");self.wait_hits(2)

    def test_css_hidden_ancestor_does_not_leave_stale_ranges(self):
        self.load();self.wait_hits(2)
        self.page.locator('#thread').evaluate("n=>n.style.display='none'");self.wait_hits(0)
        self.page.locator('#thread').evaluate("n=>n.style.display='block'");self.wait_hits(2)

    def test_external_popup_update_retains_keyboard_focus(self):
        self.load();self.wait_hits(2);self.click_hit()
        self.page.get_by_role('button',name='수정',exact=True).focus()
        self.page.evaluate('entries=>fixture.push(entries)',[item(meaning='다른 창에서 바뀐 뜻')])
        self.page.get_by_text('다른 창에서 바뀐 뜻',exact=True).wait_for()
        self.assertTrue(self.page.locator('#cdx-vocabulary-inline').evaluate('n=>n.contains(document.activeElement)'))
        self.page.keyboard.press('Escape');self.assertTrue(self.page.locator('#cdx-vocabulary-access').evaluate('n=>n===document.activeElement'))

    def test_light_dark_mobile_popovers_fit_viewport(self):
        self.load([item('bank','금융 거래를 처리하는 은행'),item('bank','강이나 하천의 둑','two')]);self.wait_hits(2);self.click_hit()
        folder=os.environ.get('CODEX_LABELS_VOCABULARY_ARTIFACTS')
        if folder:
            Path(folder).mkdir(parents=True,exist_ok=True);self.page.screenshot(path=str(Path(folder)/'inline-light.png'))
        self.page.evaluate("document.documentElement.classList.add('dark')")
        if folder:self.page.screenshot(path=str(Path(folder)/'inline-dark.png'))
        self.page.set_viewport_size({'width':390,'height':844});self.page.wait_for_timeout(100);self.click_hit()
        box=self.page.locator('#cdx-vocabulary-inline').bounding_box();self.assertGreaterEqual(box['x'],0);self.assertLessEqual(box['x']+box['width'],390)
        self.assertGreaterEqual(box['y'],0);self.assertLessEqual(box['y']+box['height'],844)
        if folder:self.page.screenshot(path=str(Path(folder)/'inline-mobile.png'))


if __name__=='__main__':
    unittest.main()
