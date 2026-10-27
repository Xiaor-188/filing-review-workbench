"""Independent local acceptance. Run only against a frozen build and isolated data.

The script imports synthetic files, exercises browser/Agent boundaries and actual
downloads, then saves a restart checkpoint. No real LLM or user study is involved.
"""
from __future__ import annotations
import argparse, base64, copy, csv, io, json, os, re, subprocess, sys, time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parent.parent
FIXTURES=ROOT/'tests'/'fixtures'
if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
NOW=lambda: datetime.now(timezone.utc).isoformat()
TEMPLATES=json.loads((FIXTURES/'candidate-templates.json').read_text(encoding='utf-8'))

def arguments():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',default='http://127.0.0.1:4318')
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--phase',choices=['flow','restart'],default='flow')
    p.add_argument('--node',default='node')
    return p.parse_args()

class Acceptance:
    def __init__(self,args,context,page):
        self.args,self.context,self.page=args,context,page
        self.out=args.out.resolve();self.out.mkdir(parents=True,exist_ok=True)
        self.results=[];self.errors=[];self.project=None;self.csrf=None
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.on('dialog',lambda d:d.dismiss())
        self.runtime=json.loads((Path(os.environ['FILINGS_DATA_DIR'])/'runtime.json').read_text(encoding='utf-8'))
        self.document_ids={}

    def record(self,name,fn):
        start=NOW()
        try:
            detail=fn()
            self.results.append(dict(name=name,status='pass',at=start,observation=detail))
            print('PASS',name,flush=True)
        except Exception as exc:
            self.results.append(dict(name=name,status='fail',at=start,observation=str(exc)))
            self.page.screenshot(path=str(self.out/f'failure-{len(self.results):02}.png'))
            print('FAIL',name,str(exc),flush=True)
            raise

    def api(self,method,path,payload=None,expected=200,agent=False,anonymous=False):
        headers={'Origin':self.args.url}
        if agent:headers['Authorization']='Bearer '+self.runtime['agent_token']
        elif not anonymous and self.csrf:headers['X-CSRF-Token']=self.csrf
        if payload is not None:headers['Content-Type']='application/json'
        request=self.context.request
        response=request.fetch(self.args.url+path,method=method,headers=headers,
                               data=json.dumps(payload) if payload is not None else None)
        assert response.status==expected,f'{method} {path}: expected {expected}, got {response.status}: {response.text()[:300]}'
        return response

    def current(self):
        self.project=self.api('GET',f'/api/projects/{self.project["id"]}').json()
        return self.project

    def cli(self,*args,out=None):
        command=[self.args.node,str(ROOT/'scripts'/'agent.mjs'),*map(str,args)]
        if out:command+=['--out',str(out)]
        run=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,encoding='utf-8',timeout=120,env=os.environ.copy())
        assert run.returncode==0,f'CLI {args[0]} failed: {run.stderr[:500]}'
        assert self.runtime['agent_token'] not in run.stdout+run.stderr,'Agent token leaked in CLI output'
        return run.stdout

    def act(self,name):return self.page.locator(f'[data-action="{name}"]').first
    def dialog_submit(self):self.page.locator('dialog[open] button[type="submit"]').last.click()
    def reload(self):
        self.page.reload(wait_until='networkidle')
        self.page.locator('#project-select').select_option(self.project['id'])
        self.page.wait_for_load_state('networkidle')
    def select_finding(self,fid):
        self.page.locator(f'[data-finding-id="{fid}"]').first.click()
    def find(self,label):return next(f for f in self.current()['findings'] if f['label']==label)
    def screenshot(self,name):self.page.screenshot(path=str(self.out/name))

    def bootstrap(self):
        response=self.page.goto(self.args.url,wait_until='networkidle');assert response.status==200
        self.csrf=self.api('GET','/api/session').json()['csrf_token']
        assert self.api('GET','/api/projects').json()==[],'Acceptance requires an isolated empty workspace'
        self.screenshot('01-empty-1280.png')
        self.act('new-project').click()
        self.page.get_by_label('项目名称',exact=True).fill('Independent QA synthetic project')
        with self.page.expect_response(lambda r:r.url.endswith('/api/projects') and r.request.method=='POST') as info:self.dialog_submit()
        assert info.value.status==201,info.value.text()
        self.project=info.value.json();assert self.project['findings']==[]
        return 'Empty state inspected; new project created through browser. Synthetic data only.'

    def documents(self):
        for ext in ['txt','csv','pdf']:
            path=FIXTURES/f'qa-financials.{ext}'
            self.act('import-document').click()
            self.page.locator('dialog[open] input[type="file"]').set_input_files(str(path))
            with self.page.expect_response(lambda r:r.url.endswith('/documents') and r.request.method=='POST') as info:self.dialog_submit()
            assert info.value.status==201,info.value.text()
            self.project=info.value.json();doc=self.project['documents'][-1]
            self.document_ids[ext]=doc['id']
            assert doc['sha256']==sha256(path.read_bytes()).hexdigest()
            original=self.api('GET',f'/api/projects/{self.project["id"]}/documents/{doc["id"]}/file')
            assert original.body()==path.read_bytes()
            assert '120.00' in '\n'.join(p['text'] for p in doc['pages'])
            if ext=='pdf':
                assert doc['page_count']==3
                assert 'Revenue' in next(p['text'] for p in doc['pages'] if p['number']==2)
        self.page.locator('#document-select').select_option(self.document_ids['pdf'])
        self.page.locator('#page-select').select_option('2')
        with self.page.expect_download() as download:self.act('open-original').click()
        original_path=self.out/'browser-original.pdf';download.value.save_as(str(original_path))
        assert original_path.read_bytes()==(FIXTURES/'qa-financials.pdf').read_bytes()
        self.screenshot('02-pdf-source.png')
        return {'imports':['txt','csv','real text PDF bytes'],'pdf_pages':3,'table_page':2,'original_bytes':'same sha256 and bytes; original PDF downloaded via browser'}

    def candidate(self,key):
        value=copy.deepcopy(TEMPLATES[key])
        for side in ['current','prior']:
            for kind,id in self.document_ids.items():
                value[side]['document_id']=value[side]['document_id'].replace('{{'+kind.upper()+'_DOCUMENT_ID}}',id)
        return value

    def agent_import(self):
        context_path=self.out/'agent-context.json'
        self.cli('context','--project',self.project['id'],out=context_path)
        context=json.loads(context_path.read_text(encoding='utf-8'))
        assert len(context['documents'])==3
        payload={'schema_version':'1.0','expected_revision':context['expected_revision'],
                 'findings':[self.candidate(k) for k in TEMPLATES]}
        payload_path=self.out/'agent-candidates.json';payload_path.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
        self.cli('import','--project',self.project['id'],'--file',payload_path,out=self.out/'agent-import-result.json')
        self.current()
        assert len(self.project['findings'])==len(TEMPLATES)
        assert all(f['status']=='pending' and f['confirmation'] is None and not f['eligible'] for f in self.project['findings'])
        self.act('refresh-project').click()
        expect(self.page.locator('[data-finding-id]')).to_have_count(len(TEMPLATES))
        return {'candidate_count':len(TEMPLATES),'status':'all pending, none eligible','method':'documented Agent CLI context/import'}

    def api_boundaries(self):
        observations=[]
        for label in ['QA revenue wrong page','QA revenue substring','QA revenue unknown',
                      'QA revenue cross document','QA revenue bad period','QA revenue currency mismatch','QA revenue unknown scope']:
            f=self.find(label)
            assert any(c['state']!='pass' for c in f['checks']),label
            response=self.api('POST',f'/api/projects/{self.project["id"]}/findings/{f["id"]}/review',
                              {'expected_revision':self.project['revision'],'action':'confirm','attested':True},expected=409)
            assert response.json()['error']['code']=='checks_blocked'
            observations.append({'case':label,'checks':f['checks'],'review_error':response.json()['error']['code']})
        swapped=self.find('QA revenue swapped columns')
        self.api('POST',f'/api/projects/{self.project["id"]}/findings/{swapped["id"]}/review',
                 {'expected_revision':self.project['revision'],'action':'confirm'},expected=400)
        valid=self.find('QA revenue TXT')
        self.api('POST',f'/api/projects/{self.project["id"]}/findings/{valid["id"]}/review',
                 {'expected_revision':self.project['revision'],'action':'confirm','attested':True},expected=403,agent=True)
        forged=self.candidate('valid_txt');forged['status']='confirmed'
        self.api('POST',f'/api/projects/{self.project["id"]}/import',
                 {'schema_version':'1.0','expected_revision':self.project['revision'],'findings':[forged]},expected=400,agent=True)
        for label in ['QA revenue zero base','QA revenue negative base']:
            f=self.find(label);assert f['calculation']['percent'] is None
            assert f['calculation']['difference_cny'] is not None
        for name in ['qa-invalid-utf8.txt','qa-pdf-disguised.txt']:
            path=FIXTURES/name
            self.api('POST',f'/api/projects/{self.project["id"]}/documents',
                     {'name':name,'content_base64':base64.b64encode(path.read_bytes()).decode()},expected=400)
        path=FIXTURES/'qa-image-only.pdf'
        self.project=self.api('POST',f'/api/projects/{self.project["id"]}/documents',
                              {'name':path.name,'content_base64':base64.b64encode(path.read_bytes()).decode()},expected=201).json()
        doc=self.project['documents'][-1]
        assert doc['warnings'] and not any(p['text'].strip() for p in doc['pages'])
        self.reload();self.page.locator('#document-select').select_option(doc['id'])
        expect(self.page.locator('#source-panel .inline-warning')).to_be_visible()
        self.screenshot('03-image-only-warning.png')
        self.select_finding(swapped['id'])
        expect(self.page.locator('.inline-note').filter(has_text='文字匹配只说明来源可追溯，不能代替对表格含义的判断。')).to_have_count(1)
        expect(self.page.locator('.attestation')).to_contain_text('核对数值所在列、主体、统计范围和期间')
        self.page.locator('#human-attestation').scroll_into_view_if_needed()
        self.screenshot('03-column-attestation.png')
        return {'negative_cases':observations,'swapped_columns':'pending; cannot confirm without explicit attestation','image_only_pdf':'warning + empty extracted text'}

    def browser_review(self):
        valid=self.find('QA revenue TXT');self.select_finding(valid['id'])
        expect(self.page.locator('#human-attestation')).not_to_be_checked()
        expect(self.act('confirm')).to_be_disabled()
        self.page.locator('#human-attestation').check();self.act('confirm').click()
        self.page.wait_for_load_state('networkidle')
        confirmed=self.find('QA revenue TXT');assert confirmed['eligible'] and confirmed['status']=='confirmed'
        original_version=confirmed['version']
        self.act('edit-finding').click()
        form=self.page.locator('#edit-form')
        form.locator('[name="current.value"]').fill('130.00')
        form.locator('[name="current.quote"]').fill('Revenue revised (CNY yuan) | 2026 H1: 130.00 | 2025 H1: 100.00')
        form.locator('[name="note"]').fill('QA: revised source row changes value and must invalidate confirmation')
        self.dialog_submit();self.page.wait_for_load_state('networkidle')
        edited=self.find('QA revenue TXT')
        assert edited['version']>original_version and not edited['eligible'] and edited['confirmation'] is None
        assert edited['current']['value']=='130.00'
        assert edited['original']['current']['value']=='120.00'
        assert edited['calculation']['percent']=='30.00'
        self.act('restore').click();self.act('restore-confirmed').click();self.page.wait_for_load_state('networkidle')
        expect(self.page.locator('#app')).to_have_attribute('aria-busy','false')
        restored=self.find('QA revenue TXT')
        assert restored['current']['value']=='120.00' and not restored['eligible'] and restored['confirmation'] is None
        expect(self.page.locator('#human-attestation')).not_to_be_checked()
        self.page.locator('#review-note').fill('QA rejection reason: return this item for another source review')
        self.act('reject').click();self.page.wait_for_load_state('networkidle')
        assert self.find('QA revenue TXT')['status']=='rejected'
        self.act('reopen').click();self.page.wait_for_load_state('networkidle')
        self.page.locator('#human-attestation').check();self.act('confirm').click()
        self.page.wait_for_load_state('networkidle')
        assert self.find('QA revenue TXT')['eligible']
        self.screenshot('04-human-review.png')
        return 'Browser checkbox confirm, source-backed value edit 120 to 130, recompute 20% to 30%, invalidation, restore, reject, reopen and reconfirm completed.'

    def browser_agent_revision(self):
        before=copy.deepcopy(self.current())
        replacement=self.candidate('valid_txt');replacement['id']=self.find('QA revenue TXT')['id']
        replacement['label']='STALE CANDIDATE MUST NOT REPLACE CONFIRMED ITEM'
        payload={'schema_version':'1.0','expected_revision':before['revision']-1,'findings':[replacement]}
        stale_path=self.out/'browser-stale-candidate.json'
        stale_path.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
        self.act('import-agent').click()
        self.page.locator('#agent-file').set_input_files(str(stale_path))
        expect(self.page.locator('#agent-json')).to_have_value(re.compile('STALE CANDIDATE'))
        with self.page.expect_response(lambda r:r.url.endswith('/import') and r.request.method=='POST') as response:self.dialog_submit()
        assert response.value.status==409 and response.value.json()['error']['code']=='stale_revision'
        expect(self.page.locator('.dialog-error')).to_contain_text('已加载最新内容')
        assert self.current()==before,'Stale browser import modified the persisted project'
        del payload['expected_revision']
        self.page.locator('#agent-json').fill(json.dumps(payload,ensure_ascii=False));self.dialog_submit()
        expect(self.page.locator('.dialog-error')).to_contain_text('expected_revision')
        assert self.current()==before,'Missing revision browser import modified the persisted project'
        # A current revision can still import a candidate, but cannot grant confirmation.
        replacement=self.candidate('valid_csv');replacement['id']=self.find('QA revenue CSV')['id']
        payload={'schema_version':'1.0','expected_revision':before['revision'],'findings':[replacement]}
        self.page.locator('#agent-json').fill(json.dumps(payload,ensure_ascii=False))
        with self.page.expect_response(lambda r:r.url.endswith('/import') and r.request.method=='POST') as response:self.dialog_submit()
        assert response.value.status==200
        imported=self.find('QA revenue CSV');assert imported['status']=='pending' and not imported['eligible']
        assert self.find('QA revenue TXT')['eligible'],'Importing another item invalidated the confirmed one'
        return 'Browser JSON file preserves expected_revision; stale and missing revisions rejected without changes; current revision accepted as pending.'

    def exports(self):
        formula=self.find('=SUM(1,1)');self.select_finding(formula['id'])
        self.page.locator('#human-attestation').check();self.act('confirm').click()
        self.page.wait_for_load_state('networkidle')
        assert self.find('=SUM(1,1)')['eligible']
        texts={}
        for fmt in ['json','csv','markdown']:
            self.act('export-menu').click()
            with self.page.expect_download() as info:self.page.locator(f'[data-action="export"][data-format="{fmt}"]').click()
            path=self.out/f'browser-export.{"md" if fmt=="markdown" else fmt}'
            info.value.save_as(str(path));texts[fmt]=path.read_text(encoding='utf-8-sig')
        payload=json.loads(texts['json']);facts=payload.get('facts',payload.get('confirmed_facts'))
        assert facts is not None,'JSON must have explicit facts section'
        assert len(facts)==2 and {f['id']for f in facts}=={self.find('QA revenue TXT')['id'],formula['id']}
        rows=list(csv.reader(io.StringIO(texts['csv'])))
        assert len(rows)==3 and len({len(row) for row in rows})==1
        assert any(cell=="'=SUM(1,1)" for row in rows for cell in row),'CSV formula text was not neutralized'
        assert 'QA revenue wrong page' not in texts['csv']
        assert 'pending' in texts['json'] or '待' in texts['markdown']
        expect(self.page.locator('dialog[open]')).to_have_count(0)
        self.cli('export','--project',self.project['id'],'--format','json',out=self.out/'cli-export.json')
        return {'formats':'all 3 actually downloaded and parsed','facts':2,'pending_excluded_from_csv':True,'formula_text_neutralized':True,'cli_export':'saved separately'}

    def viewport_and_xss(self):
        # Inspect each actual viewport, then wheel within visible panel and verify body stays put.
        findings=self.current()['findings']
        for f in findings:self.select_finding(f['id'])
        self.page.locator('#document-select').select_option(self.document_ids['txt'])
        assert self.page.evaluate('globalThis.__qaXss !== true')
        assert self.page.locator('img[onerror]').count()==0
        result=[]
        for width,height in [(1280,720),(1440,900),(390,844)]:
            self.page.set_viewport_size({'width':width,'height':height})
            self.page.wait_for_timeout(150)
            if width<600:
                self.page.locator('button[data-mobile-tab="items"]').click()
            geometry=self.page.evaluate('''() => ({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,
                sh:document.documentElement.scrollHeight,body:document.body.scrollHeight,x:scrollX,y:scrollY})''')
            assert geometry['sw']<=width+1,geometry
            assert geometry['sh']<=height+1,geometry
            panel=self.page.locator('#items-panel')
            scroll_geometry=panel.evaluate('(el)=>({height:el.clientHeight,scrollHeight:el.scrollHeight})')
            panel.hover();self.page.mouse.wheel(0,700)
            self.page.wait_for_timeout(120)
            assert self.page.evaluate('scrollY')==0,'outer page scrolled'
            if scroll_geometry['scrollHeight']>scroll_geometry['height']+1:
                assert panel.evaluate('(el)=>el.scrollTop')>0,'overflowing inner panel did not scroll'
            if width<600:
                self.select_finding(self.find('QA revenue TXT')['id'])
                self.page.locator('button[data-mobile-tab="detail"]').click()
                self.act('reopen').click();self.page.wait_for_load_state('networkidle')
                expect(self.page.locator('#human-attestation')).not_to_be_checked()
                self.page.locator('#human-attestation').check();self.act('confirm').click()
                self.page.wait_for_load_state('networkidle')
                self.act('export-menu').click()
                with self.page.expect_download() as info:self.page.locator('[data-action="export"][data-format="json"]').click()
                info.value.save_as(str(self.out/'mobile-export.json'))
                assert len(json.loads((self.out/'mobile-export.json').read_text(encoding='utf-8')).get('facts',[]))==2
                expect(self.page.locator('dialog[open]')).to_have_count(0)
            self.screenshot(f'viewport-{width}x{height}.png')
            result.append(geometry)
        assert not self.errors,self.errors
        return {'viewports':result,'xss_sentinel':'did not execute','page_errors':self.errors}

    def checkpoint(self):
        project=self.current()
        (self.out/'restart-checkpoint.json').write_text(json.dumps(project,ensure_ascii=False,indent=2),encoding='utf-8')
        return {'project_id':project['id'],'revision':project['revision'],'fact_count':sum(f['eligible'] for f in project['findings'])}

    def restart(self):
        checkpoint=json.loads((self.out/'restart-checkpoint.json').read_text(encoding='utf-8'))
        self.page.goto(self.args.url,wait_until='networkidle')
        self.csrf=self.api('GET','/api/session').json()['csrf_token'];self.project=checkpoint
        actual=self.current()
        assert actual==checkpoint,'Project differs after process restart'
        for doc in actual['documents']:
            original=self.api('GET',f'/api/projects/{actual["id"]}/documents/{doc["id"]}/file').body()
            assert sha256(original).hexdigest()==doc['sha256']
        self.page.locator('#project-select').select_option(actual['id'])
        self.screenshot('05-after-server-restart.png')
        return {'project_identical':True,'revision':actual['revision'],'original_source_hashes':'all preserved'}

    def run(self):
        steps=[('B01 empty/new project',self.bootstrap),('B02 TXT/CSV/PDF actual imports',self.documents),
               ('B04 Agent CLI context/import',self.agent_import),('B03/B05/B06/B07/B10 boundaries',self.api_boundaries),
               ('B08/B09/B10 browser review lifecycle',self.browser_review),('B04 browser Agent revision safety',self.browser_agent_revision),('B11 real downloads',self.exports),
               ('B13/B14 viewport and XSS',self.viewport_and_xss),('checkpoint before restart',self.checkpoint)]
        if self.args.phase=='restart':steps=[('B12 actual process restart recovery',self.restart)]
        try:
            for name,fn in steps:self.record(name,fn)
        finally:
            report={'at':NOW(),'phase':self.args.phase,'url':self.args.url,'environment':sys.version,
                    'summary':{'passed':sum(r['status']=='pass'for r in self.results),'failed':sum(r['status']=='fail'for r in self.results)},
                    'results':self.results,'page_errors':self.errors,
                    'limitations':['Automated browser acceptance, not human user research.','No real LLM call.','B06 requires manual review of the recorded UI wording.']}
            (self.out/f'browser-{self.args.phase}-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    args=arguments()
    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True)
        try:
            context=browser.new_context(viewport={'width':1280,'height':720},accept_downloads=True)
            Acceptance(args,context,context.new_page()).run()
        finally:browser.close()
