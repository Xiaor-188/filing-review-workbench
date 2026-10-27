import { createHash, randomUUID } from 'node:crypto';
import { fail, exactFields, boundedString } from './errors.mjs';

export const RULES_VERSION = 'review-1.0.0';
const FACTORS = Object.freeze({ '元': 1n, '万元': 10000n, '亿元': 100000000n });
export const INPUT_FIELDS = ['document_id','page','quote','value','unit','currency','entity','scope','period_start','period_end','period_type'];
const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const normalText = text => String(text).replace(/\s+/gu, ' ').trim();

// Internal normalized amounts can have more whole digits after unit conversion.
// Only call this with a validated input or a string produced by decimalText().
function parseDecimal(value) {
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return { n: BigInt(whole + fraction) * (value.startsWith('-') ? -1n : 1n), scale: fraction.length };
}
function decimal(value) {
  if (typeof value !== 'string' || !/^-?\d{1,40}(?:\.\d{1,16})?$/.test(value)) fail(400, 'invalid_amount', '金额须为普通十进制字符串或 null，不接受数值类型、科学计数法或千分位。');
  return parseDecimal(value);
}
const pow = scale => 10n ** BigInt(scale);
function align(a,b) { const scale = Math.max(a.scale,b.scale); return { a:a.n*pow(scale-a.scale),b:b.n*pow(scale-b.scale),scale }; }
function decimalText(n,scale,minimum=2) {
  const sign=n<0n?'-':'';
  const digits=(n<0n?-n:n).toString().padStart(scale+1,'0');
  const whole=scale?digits.slice(0,-scale):digits;
  const fraction=(scale?digits.slice(-scale):'').replace(/0+$/,'').padEnd(minimum,'0');
  return `${sign}${whole}${fraction?'.'+fraction:''}`;
}
function fixedDivide(n,d,places=2) {
  const negative=(n<0n)!==(d<0n); n=(n<0n?-n:n)*pow(places);d=d<0n?-d:d;
  const rounded=n/d+((n%d)*2n>=d?1n:0n);
  const digits=rounded.toString().padStart(places+1,'0');
  return `${negative&&rounded!==0n?'-':''}${digits.slice(0,-places)}.${digits.slice(-places)}`;
}
export function normalizeAmount(value,unit) {
  if(value===null || !FACTORS[unit])return null;
  const amount=decimal(value);return decimalText(amount.n*FACTORS[unit],amount.scale);
}
export function calculate(current,prior) {
  const current_cny=current.currency==='CNY'?normalizeAmount(current.value,current.unit):null;
  const prior_cny=prior.currency==='CNY'?normalizeAmount(prior.value,prior.unit):null;
  const base={current_cny,prior_cny,difference_cny:null,percent:null,status:'missing'};
  if(current_cny===null || prior_cny===null)return base;
  const values=align(parseDecimal(current_cny),parseDecimal(prior_cny));
  base.difference_cny=decimalText(values.a-values.b,values.scale);
  if(values.b===0n)return {...base,status:'zero_base'};
  if(values.b<0n)return {...base,status:'negative_base'};
  return {...base,percent:fixedDivide((values.a-values.b)*100n,values.b),status:'pass'};
}
function sameAmount(a,b) { const numbers=align(decimal(a),decimal(b)); return numbers.a===numbers.b; }
export function amountInQuote(value,quote) {
  if(value===null)return false;
  // Parse whole numeric tokens, never match 120 inside 1200.00, -120, or 120.01.
  const numbers=String(quote).match(/(?<![A-Za-z_\d.,])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![A-Za-z_\d]|[.,]\d)/g)||[];
  return numbers.some(token=>{try{return sameAmount(value,token.replaceAll(',','').replace(/^\+/,''));}catch{return false;}});
}
export function validateInput(input,documents) {
  exactFields(input,INPUT_FIELDS,INPUT_FIELDS);
  const document_id=boundedString(input.document_id,'文档 ID',{max:80});
  if(!documents.some(d=>d.id===document_id))fail(400,'unknown_document','候选引用了未导入的文档 ID。');
  if(input.page!==null && (!Number.isSafeInteger(input.page)||input.page<1||input.page>100000))fail(400,'invalid_page','页码须为正整数或 null。');
  if(input.value!==null)decimal(input.value);
  if(!['元','万元','亿元',''].includes(input.unit))fail(400,'invalid_unit','单位只支持元、万元、亿元；未知时可留空。');
  if(!['flow','instant',''].includes(input.period_type))fail(400,'invalid_period_type','指标属性只支持 flow、instant；未知时可留空。');
  return {document_id,page:input.page,quote:boundedString(input.quote,'引用原文',{max:12000,empty:true}),value:input.value,
    unit:input.unit,currency:boundedString(input.currency,'币种',{max:12,empty:true}),
    entity:boundedString(input.entity,'主体',{max:200,empty:true}),scope:boundedString(input.scope,'口径',{max:300,empty:true}),
    period_start:boundedString(input.period_start,'期间起点',{max:40,empty:true}),period_end:boundedString(input.period_end,'期间终点',{max:40,empty:true}),period_type:input.period_type};
}
function check(key,label,state,reason){return {key,label,state,reason};}
function dateValid(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const date=new Date(value+'T00:00:00Z');return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function sourceChecks(input,documents,key){
  const doc=documents.find(d=>d.id===input.document_id);
  const page=doc?.pages.find(p=>p.number===input.page);
  const integrity=doc?.integrity?.state||'unknown';
  const quotePresent=!!page&&!!input.quote&&normalText(page.text).includes(normalText(input.quote));
  const amountPresent=amountInQuote(input.value,input.quote);
  return [
    check(`${key}_document`,'来源文件',!doc?'fail':integrity,doc?.integrity?.reason||'来源字节完整性尚未核验。'),
    check(`${key}_page`,'引用页码',input.page===null?'unknown':page?'pass':'fail',input.page===null?'页码未知，请在原文中定位。':page?`已定位 ${doc.name} 第 ${input.page} 页。`:'引用页码超出文档实际页数。'),
    check(`${key}_quote`,'原文引用',!input.quote?'unknown':quotePresent?'pass':'fail',!input.quote?'尚未提供支持引文。':quotePresent?'引文可在指定页逐字定位；列、主体和期间含义仍需人工核对。':'引用原文不能在指定页定位，请重新选择原文。'),
    check(`${key}_amount`,'金额出处',input.value===null?'unknown':amountPresent?'pass':'fail',input.value===null?'金额未知，不按零计算。':amountPresent?'完整金额 token 出现在引文中；这不证明选中了正确期间列。':'引文不含此完整金额；不能用部分数字匹配作为依据。'),
    check(`${key}_unit`,'金额单位',FACTORS[input.unit]?'pass':'unknown',FACTORS[input.unit]?`${input.unit} × ${FACTORS[input.unit]} 归一为元；请人工核实原文的单位。`:'单位未知，无法归一。'),
  ];
}
function equalField(key,label,a,b){return check(key,label,!a||!b?'unknown':a===b?'pass':'fail',!a||!b?`${label}有缺失，不能默认一致。`:a===b?`两期输入${label}一致；原文归属仍须人工确认。`:`两期${label}不一致，不能直接比较。`);}
function periodChecks(current,prior){
  const values=[current.period_start,current.period_end,prior.period_start,prior.period_end];
  if(values.some(v=>!v))return check('period','期间可比性','unknown','期间起止日期缺失，请按原文补充。');
  if(!values.every(dateValid))return check('period','期间可比性','fail','存在无效日历日期；请使用实际 YYYY-MM-DD。');
  if(current.period_start>current.period_end||prior.period_start>prior.period_end)return check('period','期间可比性','fail','期间起点晚于终点。');
  if(current.period_type==='instant'&&(current.period_start!==current.period_end||prior.period_start!==prior.period_end))return check('period','期间可比性','fail','时点指标起止必须为同一天，不能当作期间流量。');
  const previousYear=(a,b)=>Number(a.slice(0,4))===Number(b.slice(0,4))+1&&a.slice(4)===b.slice(4);
  const valid=previousYear(current.period_start,prior.period_start)&&previousYear(current.period_end,prior.period_end);
  return check('period','期间可比性',valid?'pass':'fail',valid?'输入为上年同期的相同日历区间；原文列义仍须人工核对。':'首版只支持上年同期比较；累计半年与单季、不同长度期间不可直接比较。');
}
function signature(finding,documents){
  return createHash('sha256').update(JSON.stringify({label:finding.label,metric:finding.metric,current:finding.current,prior:finding.prior,version:finding.version,
    sources:[finding.current.document_id,finding.prior.document_id].map(id=>({id,sha256:documents.find(d=>d.id===id)?.sha256})),rules:RULES_VERSION})).digest('hex');
}
export function deriveFinding(finding,documents){
  const {current,prior}=finding;
  const calculation=calculate(current,prior);
  const checks=[...sourceChecks(current,documents,'current'),...sourceChecks(prior,documents,'prior'),
    check('metric','指标定义',finding.metric?'pass':'unknown',finding.metric?'两期使用同一指标定义；是否对应原文同一行需人工复核。':'指标定义为空。'),
    equalField('entity','主体',current.entity,prior.entity),equalField('scope','口径',current.scope,prior.scope),equalField('currency','币种',current.currency,prior.currency),
    check('supported_currency','支持币种',!current.currency||!prior.currency?'unknown':current.currency==='CNY'&&prior.currency==='CNY'?'pass':'unknown',current.currency==='CNY'&&prior.currency==='CNY'?'人民币金额，可按元单位计算。':'首版仅支持 CNY 人民币；其他币种待核，不将外币值当成人民币。'),
    equalField('period_type','指标属性',current.period_type,prior.period_type),periodChecks(current,prior),
    check('document_comparison','跨文件口径',current.document_id===prior.document_id?'pass':'unknown',current.document_id===prior.document_id?'同一文件中的比较；仍需核对是否同表、同范围。':'跨文档会计范围与修订链未建立验证路径，首版保持待核。'),
    check('calculation','同比计算',calculation.status==='pass'?'pass':'unknown',({pass:'使用原始精度计算，仅在百分比显示时舍入。',missing:'金额、单位或币种缺失，暂不能计算。',zero_base:'基期为零，仅展示金额差额，不产生普通同比。',negative_base:'基期为负，仅展示金额差额，增长口径需另行定义。'})[calculation.status]),
  ];
  const confirmation=finding.confirmation;
  const valid=!!(finding.status==='confirmed'&&confirmation&&confirmation.version===finding.version&&confirmation.signature===signature(finding,documents)&&confirmation.rules_version===RULES_VERSION&&confirmation.attested===true);
  return {...clone(finding),checks,calculation,eligible:valid&&checks.every(c=>c.state==='pass')};
}
export function deriveProject(project){return {...clone(project),findings:project.findings.map(f=>deriveFinding(f,project.documents))};}
export function event(project,actor,action,detail,finding_id){project.events.push({id:randomUUID(),at:now(),action,...(finding_id?{finding_id}:{}),actor,detail});}
const workingFingerprint=f=>JSON.stringify({label:f.label,metric:f.metric,current:f.current,prior:f.prior});
export function importFindings(project,payload,actor){
  exactFields(payload,['schema_version','expected_revision','findings'],['schema_version','expected_revision','findings']);
  if(payload.schema_version!=='1.0'||!Array.isArray(payload.findings)||payload.findings.length<1||payload.findings.length>100)fail(400,'invalid_import','导入须为 schema_version 1.0，含 1–100 条发现。');
  const ids=new Set();
  const prepared=payload.findings.map(item=>{
    exactFields(item,['id','label','metric','current','prior'],['label','metric','current','prior']);
    const id=item.id===undefined?randomUUID():boundedString(item.id,'事项 ID',{max:80});
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)||ids.has(id))fail(400,'invalid_finding_id','事项 ID 无效或同一批导入重复。');ids.add(id);
    const label=boundedString(item.label,'事项名称',{max:200});const metric=boundedString(item.metric,'指标定义',{max:200,empty:true});
    const current=validateInput(item.current,project.documents),prior=validateInput(item.prior,project.documents);
    return {id,label,metric,current,prior};
  });
  if(project.findings.length+prepared.filter(f=>!project.findings.some(old=>old.id===f.id)).length>500)fail(413,'finding_limit','每个项目最多保留 500 条事项。');
  for(const candidate of prepared){
    const existing=project.findings.find(f=>f.id===candidate.id);
    if(existing){
      if(workingFingerprint(existing)!==workingFingerprint(candidate)){
        Object.assign(existing,candidate,{version:existing.version+1,status:'pending',confirmation:null});
        event(project,actor,'replace_candidate','采用同 ID 的新候选；原始导入保留，旧确认已失效。',existing.id);
      }
    }else{
      project.findings.push({...candidate,original:clone({label:candidate.label,metric:candidate.metric,current:candidate.current,prior:candidate.prior}),version:1,status:'pending',note:'',confirmation:null});
      event(project,actor,'import_candidate','导入结构化候选，等待人工核对。',candidate.id);
    }
  }
}
export function editFinding(project,id,payload,actor){
  exactFields(payload,['expected_revision','label','current','prior','note'],['expected_revision']);
  const finding=project.findings.find(f=>f.id===id);if(!finding)fail(404,'finding_not_found','事项不存在。');
  const supplied=Object.keys(payload).filter(key=>key!=='expected_revision');if(!supplied.length)fail(400,'empty_edit','没有需要修改的内容。');
  const note=payload.note===undefined?finding.note:boundedString(payload.note,'修改说明',{max:4000,empty:true});
  const changedInput=['label','current','prior'].some(key=>key in payload);
  if(changedInput&&!note.trim())fail(400,'edit_reason_required','修改数值或口径前请填写 note 说明依据。');
  const before=workingFingerprint(finding);
  const prepared={...finding,note};
  if('label'in payload)prepared.label=boundedString(payload.label,'事项名称',{max:200});
  if('current'in payload)prepared.current=validateInput(payload.current,project.documents);
  if('prior'in payload)prepared.prior=validateInput(payload.prior,project.documents);
  if(before!==workingFingerprint(prepared)||note!==finding.note){
    Object.assign(finding,prepared,{version:finding.version+1,status:'pending',confirmation:null});
    event(project,actor,'edit_finding',note||'更新工作副本；旧确认已失效。',id);
  }
}
export function reviewFinding(project,id,payload,actor){
  if(actor!=='browser')fail(403,'human_review_only','Agent 只能提出或修改候选；确认、驳回、恢复及重新打开须在浏览器人工完成。');
  exactFields(payload,['expected_revision','action','attested','note'],['expected_revision','action']);
  if(!['confirm','reject','reopen','restore'].includes(payload.action))fail(400,'invalid_action','未知复核动作。');
  if('attested'in payload&&typeof payload.attested!=='boolean')fail(400,'invalid_attestation','attested 必须是布尔值。');
  const note=payload.note===undefined?'':boundedString(payload.note,'复核说明',{max:4000,empty:true});
  const finding=project.findings.find(f=>f.id===id);if(!finding)fail(404,'finding_not_found','事项不存在。');
  if(payload.action==='confirm'){
    if(payload.attested!==true)fail(400,'attestation_required','请先人工核对原文列、单位、主体和期间，并勾选复核确认。');
    if(finding.status==='rejected')fail(409,'reopen_required','已驳回事项需要先重新打开。');
    const derived=deriveFinding(finding,project.documents);
    if(derived.checks.some(c=>c.state!=='pass'))fail(409,'checks_blocked','仍有失败或未知检查，不能确认。请先处理来源或口径。');
    finding.status='confirmed';if(note)finding.note=note;
    finding.confirmation={version:finding.version,signature:signature(finding,project.documents),rules_version:RULES_VERSION,attested:true,at:now(),actor:'browser'};
    event(project,actor,'confirm',note||'人工确认当前原文列、主体、期间及单位。',id);
  }else if(payload.action==='reject'){
    if(!note)fail(400,'review_reason_required','请填写驳回原因。');
    finding.status='rejected';finding.confirmation=null;finding.note=note;event(project,actor,'reject',note,id);
  }else if(payload.action==='reopen'){
    finding.status='pending';finding.confirmation=null;event(project,actor,'reopen',note||'重新打开，等待本版本人工复核。',id);
  }else{
    Object.assign(finding,clone(finding.original),{version:finding.version+1,status:'pending',confirmation:null});
    if(note)finding.note=note;
    event(project,actor,'restore',note||'恢复最初导入的原始输入；旧确认不会自动恢复。',id);
  }
}

export function exportRecord(project){
  const derived=deriveProject(project);
  return {schema_version:'1.0',project:{id:project.id,name:project.name,revision:project.revision},exported_at:now(),rules_version:RULES_VERSION,
    facts:derived.findings.filter(f=>f.eligible),pending_records:derived.findings.filter(f=>!f.eligible),
    sources:project.documents.map(({pages,...doc})=>clone(doc)),events:clone(project.events),
    note:'事实只含当前有效的人工确认；待核与驳回事项单独保留。引文匹配证明可追溯性，原文列义与口径由人工复核。'};
}
function csvCell(value,numeric=false){let text=value==null?'':String(value);if(!numeric&&/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
const md=value=>String(value??'未知').replace(/[\\`*_{}\[\]<>#|]/g,'\\$&');
export function serializeReport(record,format){
  if(format==='json')return JSON.stringify(record,null,2)+'\n';
  if(format==='csv'){
    const headers=['项目类型','ID','名称','指标','主体','口径','本期起','本期止','上期起','上期止','币种','本期原值','本期单位','上期原值','上期单位','本期元','上期元','差额元','同比%','本期文档','本期页','本期引文','上期文档','上期页','上期引文','版本','确认时间','批注'];
    const rows=[headers.map(x=>csvCell(x)).join(',')];
    for(const f of record.facts){const c=f.current,p=f.prior;const values=['已确认事实',f.id,f.label,f.metric,c.entity,c.scope,c.period_start,c.period_end,p.period_start,p.period_end,c.currency,c.value,c.unit,p.value,p.unit,f.calculation.current_cny,f.calculation.prior_cny,f.calculation.difference_cny,f.calculation.percent,c.document_id,c.page,c.quote,p.document_id,p.page,p.quote,f.version,f.confirmation.at,f.note];rows.push(values.map((v,i)=>csvCell(v,[11,13,15,16,17,18,20,23,25].includes(i))).join(','));}
    return '\uFEFF'+rows.join('\r\n')+'\r\n';
  }
  if(format==='markdown'){
    const lines=[`# ${md(record.project.name)} · 财报复核记录`,'',`项目版本：${record.project.revision}；导出时间：${record.exported_at}`,'',`已确认事实 ${record.facts.length} 项；待核或驳回 ${record.pending_records.length} 项。`,'','## 已确认事实',''];
    const item=(f,confirmed)=>{
      lines.push(`### ${md(f.label)} · ${md(f.id)}`,'',`状态：${confirmed?'已确认':f.status==='rejected'?'已驳回':'待核'}；事项版本 ${f.version}；指标 ${md(f.metric)}`);
      for(const [label,input]of [['本期',f.current],['上期',f.prior]])lines.push(`- ${label}：${input.value??'未知'} ${md(input.unit||'未知单位')}；${md(input.period_start||'未知')}—${md(input.period_end||'未知')}；主体 ${md(input.entity||'未知')}；口径 ${md(input.scope||'未知')}；来源 ${input.document_id} 第 ${input.page??'未知'} 页。`,`  引文：${md(input.quote||'未提供')}`);
      lines.push(`差额：${f.calculation.difference_cny??'待核'} 元；同比：${f.calculation.percent===null?'不适用或待核':f.calculation.percent+'%'}。`, `计算：\`(本期归一金额 - 上期归一金额) / 上期归一金额 × 100\``, `批注：${md(f.note||'无')}`);
      if(!confirmed)for(const c of f.checks.filter(c=>c.state!=='pass'))lines.push(`- ${md(c.label)}：${md(c.reason)}`);
      lines.push('');
    };
    record.facts.forEach(f=>item(f,true));lines.push('## 待核与驳回记录','','以下不属于已确认事实。','');record.pending_records.forEach(f=>item(f,false));
    lines.push('## 来源','');for(const source of record.sources)lines.push(`- ${md(source.name)} / ${source.id} / ${source.page_count} 页 / SHA-256：\`${source.sha256}\`。`);
    lines.push('','## 处理记录','');for(const e of record.events)lines.push(`- ${e.at} · ${e.actor} · ${e.action} · ${md(e.finding_id||'')} · ${md(e.detail)}`);
    lines.push('',record.note,'');return lines.join('\n');
  }
  fail(400,'unsupported_export','仅支持 json、csv 或 markdown。');
}
