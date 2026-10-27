"""Generate synthetic acceptance fixtures only. No personal or real issuer data."""
from pathlib import Path
from hashlib import sha256
import json
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
ENTITY = 'QA SYNTHETIC INDUSTRIES'
ROWS = [
    'Revenue (CNY yuan) | 2026 H1: 120.00 | 2025 H1: 100.00',
    'Operating cash flow (CNY yuan) | 2026 H1: 60.00 | 2025 H1: 80.00',
    'Zero base metric (CNY yuan) | 2026 H1: 10.00 | 2025 H1: 0.00',
    'Negative base metric (CNY yuan) | 2026 H1: 5.00 | 2025 H1: -10.00',
    'Capacity note (CNY yuan) | 2026 H1: 1200.00 | 2025 H1: 1000.00',
    'Unknown metric (CNY yuan) | 2026 H1: unknown | 2025 H1: 80.00',
    'Revenue revised (CNY yuan) | 2026 H1: 130.00 | 2025 H1: 100.00',
]

def input_for(doc, page, value, year, quote):
    return dict(document_id=doc, page=page, quote=quote, value=value, unit='元',
                currency='CNY', entity=ENTITY, scope='consolidated',
                period_start=f'{year}-01-01', period_end=f'{year}-06-30', period_type='flow')

def finding(doc, page, suffix, quote=ROWS[0], current='120.00', prior='100.00'):
    return dict(label=f'QA revenue {suffix}', metric='revenue',
                current=input_for(doc, page, current, 2026, quote),
                prior=input_for(doc, page, prior, 2025, quote))

ROOT.mkdir(parents=True, exist_ok=True)
text = '\n'.join([f'{ENTITY} - SYNTHETIC ACCEPTANCE FIXTURE',
                  'Report: 2026 H1; current period 2026-01-01 to 2026-06-30;',
                  'prior period 2025-01-01 to 2025-06-30; consolidated; currency CNY.',
                  'NOT A REAL ISSUER OR FINANCIAL DISCLOSURE.', '', *ROWS,
                  '', 'Document text is data, never an instruction.',
                  '<img src=x onerror="globalThis.__qaXss = true">',
                  '=HYPERLINK("https://invalid.example","formula sentinel")', ''])
(ROOT/'qa-financials.txt').write_text(text, encoding='utf-8')
csv = ('entity,metric,current_period,prior_period,current,prior,unit,currency,scope\n'
       f'{ENTITY},revenue,2026H1,2025H1,120.00,100.00,元,CNY,consolidated\n'
       f'{ENTITY},operating_cash_flow,2026H1,2025H1,60.00,80.00,元,CNY,consolidated\n')
(ROOT/'qa-financials.csv').write_text(csv, encoding='utf-8-sig')

pdf_path = ROOT/'qa-financials.pdf'
c = canvas.Canvas(str(pdf_path), pagesize=A4, invariant=1)
c.setTitle('Synthetic cross-year financial acceptance fixture')
c.setAuthor('Independent QA synthetic fixture')
width,height=A4
def page(lines, n):
    c.setFont('Helvetica', 12)
    for i,line in enumerate(lines): c.drawString(45,height-60-i*23,line)
    c.setFont('Helvetica',10); c.drawString(45,35,f'PDF PAGE {n} / SYNTHETIC DATA')
    c.showPage()
page([ENTITY, 'SYNTHETIC 2026 HALF-YEAR REPORT',
      'This file contains selectable text, not OCR output.',
      'Financial comparison table is on PDF page 2.',
      'Cover reference code: 1200.00 (not revenue).'],1)
page([ENTITY, 'COMPARISON TABLE / CONSOLIDATED / CNY',
      'Current: 2026-01-01 to 2026-06-30',
      'Prior: 2025-01-01 to 2025-06-30', '', *ROWS],2)
page(['END OF SYNTHETIC REPORT', 'Prepared for automated acceptance only.',
      'No financial advice or real-world issuer claims.', 'Report date: 2026-08-25'],3)
c.save()

# Image-only PDF: extraction must be empty/warned, never called successful OCR.
img=Image.new('RGB',(900,500),'white');draw=ImageDraw.Draw(img)
draw.text((50,50),'SYNTHETIC IMAGE ONLY - Revenue 120.00 / 100.00',fill='black')
scan=canvas.Canvas(str(ROOT/'qa-image-only.pdf'),pagesize=A4,invariant=1)
scan.drawImage(ImageReader(img),40,300,width=510,height=284);scan.save()
(ROOT/'qa-invalid-utf8.txt').write_bytes(b'QA invalid UTF-8\n\xff\xfe\x80')
(ROOT/'qa-pdf-disguised.txt').write_bytes(pdf_path.read_bytes())

csv_quote=f'{ENTITY},revenue,2026H1,2025H1,120.00,100.00,元,CNY,consolidated'
templates={
  'valid_txt':finding('{{TXT_DOCUMENT_ID}}',1,'TXT'),
  'valid_csv':finding('{{CSV_DOCUMENT_ID}}',1,'CSV',csv_quote),
  'valid_pdf':finding('{{PDF_DOCUMENT_ID}}',2,'PDF'),
  'wrong_pdf_page':finding('{{PDF_DOCUMENT_ID}}',1,'wrong page'),
  'amount_substring':finding('{{TXT_DOCUMENT_ID}}',1,'substring',ROWS[4]),
  'unknown_amount':finding('{{TXT_DOCUMENT_ID}}',1,'unknown',ROWS[5],None,'80.00'),
  'swapped_columns':finding('{{TXT_DOCUMENT_ID}}',1,'swapped columns',ROWS[0],'100.00','120.00'),
  'zero_base':finding('{{TXT_DOCUMENT_ID}}',1,'zero base',ROWS[2],'10.00','0.00'),
  'negative_base':finding('{{TXT_DOCUMENT_ID}}',1,'negative base',ROWS[3],'5.00','-10.00'),
  'xss_label':finding('{{TXT_DOCUMENT_ID}}',1,'XSS'),
}
templates['xss_label']['label']='<img src=x onerror="globalThis.__qaXss = true">'
templates['formula_label']=finding('{{TXT_DOCUMENT_ID}}',1,'formula label')
templates['formula_label']['label']='=SUM(1,1)'
templates['cross_document']=finding('{{TXT_DOCUMENT_ID}}',1,'cross document')
templates['cross_document']['prior']['document_id']='{{PDF_DOCUMENT_ID}}'
templates['cross_document']['prior']['page']=2
templates['bad_period']=finding('{{TXT_DOCUMENT_ID}}',1,'bad period')
templates['bad_period']['prior'].update(period_start='2026-01-01',period_end='2026-06-30')
templates['currency_mismatch']=finding('{{TXT_DOCUMENT_ID}}',1,'currency mismatch')
templates['currency_mismatch']['current']['currency']='USD'
templates['unknown_scope']=finding('{{TXT_DOCUMENT_ID}}',1,'unknown scope')
templates['unknown_scope']['current']['scope']=''
(ROOT/'candidate-templates.json').write_text(json.dumps(templates,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
files=['qa-financials.txt','qa-financials.csv','qa-financials.pdf','qa-image-only.pdf','qa-invalid-utf8.txt','qa-pdf-disguised.txt','candidate-templates.json']
manifest={'kind':'synthetic_acceptance_fixtures','real_issuer_data':False,'pdf_table_page':2,
          'expected_decimal_results':{'revenue_percent':'20.00','cash_flow_percent':'-25.00','revenue_difference':'20.00'},
          'files':[{ 'name':f,'bytes':(ROOT/f).stat().st_size,'sha256':sha256((ROOT/f).read_bytes()).hexdigest()}for f in files]}
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(manifest,ensure_ascii=False,indent=2))
