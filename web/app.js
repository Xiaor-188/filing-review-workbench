const app = document.querySelector('#app');
const dialogRoot = document.querySelector('#dialog-root');
const state = { token: '', projects: [], project: null, findingId: null, documentId: null, page: 1, tab: 'items', filter: 'all', query: '', notice: null, busy: false, noteDrafts: {} };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = value => encodeURIComponent(value);
const noteKey = id => `${state.project?.id || ''}:${id}`;
const currentFinding = () => state.project?.findings.find(f => f.id === state.findingId);
const projectPath = () => `/api/projects/${enc(state.project.id)}`;
const isConfirmed = f => f.status === 'confirmed' && f.eligible === true && !!f.confirmation;
const canReview = f => Array.isArray(f.checks) && f.checks.length > 0 && f.checks.every(check => check.state === 'pass');
const shortId = id => String(id || '').slice(0, 8);
const statusLabel = f => isConfirmed(f) ? '已确认' : f.status === 'confirmed' ? '确认已失效' : f.status === 'rejected' ? '已驳回' : canReview(f) ? '待复核' : '待补充';
const statusClass = f => isConfirmed(f) ? 'confirmed' : f.status === 'confirmed' ? 'blocked' : f.status === 'rejected' ? 'rejected' : canReview(f) ? 'pending' : 'blocked';
const display = (value, fallback = '未提供') => value == null || value === '' ? fallback : String(value);
const numberText = value => { if (value == null || value === '') return '—'; const [whole, fraction] = String(value).split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction); };
const dateText = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false }); };
const badge = f => `<span class="badge ${statusClass(f)}">${statusLabel(f)}</span>`;
const icon = name => ({ plus: '+', arrow: '↗', close: '×', check: '✓', dot: '·' }[name] || '');

async function api(path, options = {}) {
  const headers = { 'X-CSRF-Token': state.token, ...options.headers };
  if (options.body && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error?.message || `请求未完成（${response.status}）`);
    error.status = response.status; error.code = body.error?.code;
    throw error;
  }
  return options.raw ? response : response.json();
}

function notice(message, type = 'info') { state.notice = { message, type }; }
function syncSelection() {
  const p = state.project;
  if (!p) { state.findingId = null; state.documentId = null; return; }
  if (!p.findings.some(f => f.id === state.findingId)) state.findingId = p.findings[0]?.id || null;
  if (!p.documents.some(d => d.id === state.documentId)) state.documentId = p.documents[0]?.id || null;
  const doc = p.documents.find(d => d.id === state.documentId);
  if (!doc?.pages.some(p => p.number === Number(state.page))) state.page = doc?.pages[0]?.number || 1;
}
function updateProject(project) {
  state.project = project;
  const meta = { id: project.id, name: project.name, revision: project.revision, document_count: project.documents.length, finding_count: project.findings.length };
  state.projects = [meta, ...state.projects.filter(p => p.id !== project.id)];
  syncSelection();
  try { localStorage.setItem('filing-review-project', project.id); } catch {}
}
async function loadProject(id) {
  state.findingId = null; state.documentId = null; state.page = 1; state.filter = 'all'; state.query = ''; state.tab = 'items';
  updateProject(await api(`/api/projects/${enc(id)}`));
}
async function run(action) {
  if (state.busy) return;
  state.busy = true; setBusy(true);
  try { await action(); }
  catch (error) {
    if (error.code === 'stale_revision' && state.project) {
      try { updateProject(await api(projectPath())); } catch {}
      notice('项目已在其他窗口或 Agent 中更新。已加载最新内容，请重新检查后操作。', 'warning');
    } else notice(error.message || '操作未完成，请重试。', 'error');
    const content = dialogRoot.querySelector('.modal-content');
    if (content) { content.querySelector('.dialog-error')?.remove(); const message = document.createElement('p'); message.className = 'dialog-error inline-warning'; message.setAttribute('role', 'alert'); message.textContent = state.notice.message; content.prepend(message); content.scrollTop = 0; }
  } finally { state.busy = false; render(); }
}
function setBusy(busy) {
  app.setAttribute('aria-busy', String(busy));
  document.querySelectorAll('button').forEach(el => { if (busy && !el.disabled) { el.dataset.busyDisabled = 'true'; el.disabled = true; } else if (!busy && el.dataset.busyDisabled) { el.disabled = false; delete el.dataset.busyDisabled; } });
}

function render() {
  const scrolls = Object.fromEntries([...app.querySelectorAll('[data-scroll]')].map(el => [el.id, el.scrollTop]));
  app.innerHTML = `<main class="workbench" data-mobile-tab="${esc(state.tab)}">
    <header class="app-header"><div class="brand"><span class="brand-mark" aria-hidden="true">DODO</span><div><h1>财报复核工作台</h1><p>从原文到研究记录</p></div></div>
      <div class="project-switch"><label for="project-select">项目</label><select id="project-select" ${state.projects.length ? '' : 'disabled'}><option value="" disabled>${state.projects.length ? '选择项目' : '还没有项目'}</option>${state.projects.map(p => `<option value="${esc(p.id)}" ${state.project?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button class="icon-button" data-action="new-project" aria-label="新建项目" title="新建项目">${icon('plus')}</button><button class="icon-button refresh-button" data-action="refresh-project" aria-label="刷新项目数据" title="刷新项目数据" ${!state.project ? 'disabled' : ''}>↻</button></div>
      <div class="header-status"><i aria-hidden="true"></i><span>本地工作区</span></div></header>
    <section class="command-bar" aria-label="项目操作"><div class="project-caption"><strong>${esc(state.project?.name || '开始一份新的复核')}</strong><span>${state.project ? `版本 ${esc(state.project.revision)} · ${state.project.findings.length} 个事项` : '导入资料后，由你决定哪些数据可以写入记录'}</span></div><div class="command-actions"><button class="primary" data-action="import-document" ${!state.project ? 'disabled' : ''}>导入文档</button><button data-action="import-agent" ${!state.project ? 'disabled' : ''}>Agent 候选</button><button data-action="export-menu" ${!state.project ? 'disabled' : ''}>导出</button><button class="icon-button subtle" data-action="project-menu" aria-label="项目管理" ${!state.project ? 'disabled' : ''}>···</button></div></section>
    ${state.notice ? `<div class="notice ${esc(state.notice.type)}" role="status" aria-live="polite"><span>${esc(state.notice.message)}</span><button class="icon-button" data-action="dismiss-notice" aria-label="关闭提示">×</button></div>` : ''}
    ${state.project ? projectMarkup() : welcomeMarkup()}
    <footer class="app-footer"><span>文档保存在本机 <b>·</b> 未连接模型</span><button class="text-button" data-action="help">如何与 Agent 配合</button><span class="save-status">${state.project ? `已保存 ${esc(dateText(state.project.updated_at))}` : 'PDF / TXT / CSV'}</span></footer>
  </main>`;
  for (const [id, top] of Object.entries(scrolls)) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
  setBusy(state.busy);
}

function welcomeMarkup() {
  return `<section class="welcome" data-scroll id="welcome-panel"><div class="welcome-intro"><span class="eyebrow">一份资料，一条可核对的记录</span><h2>先把原文放在手边。</h2><p>导入财报或表格文本，接收 Agent 整理的候选数据，再逐项核对来源、口径和计算结果。</p><div class="welcome-actions"><button class="primary" data-action="new-project">新建项目</button><button data-action="load-sample">试用构造样例</button></div><small>构造样例仅用于熟悉流程，不代表真实公司数据。</small></div><ol class="welcome-steps"><li><span>01</span><div><h3>放入资料</h3><p>保留原文件和按页文本。扫描版 PDF 暂不支持识别。</p></div></li><li><span>02</span><div><h3>接收候选</h3><p>让你使用的 Agent 按约定整理 JSON，再导入这里。</p></div></li><li><span>03</span><div><h3>人工复核</h3><p>核对原文和可比口径，确认后的数据才进入事实记录。</p></div></li></ol></section>`;
}
function projectMarkup() {
  const p = state.project;
  return `<nav class="mobile-tabs" aria-label="工作台分区">${[['overview', '概览'], ['sources', '原文'], ['items', '事项'], ['detail', '复核']].map(([key, label]) => `<button data-mobile-tab="${key}" aria-pressed="${state.tab === key}">${label}</button>`).join('')}</nav>
    ${overviewMarkup(p)}
    <div class="columns"><aside id="source-panel" class="source-panel panel" data-scroll aria-label="文档原文">${sourceMarkup(p)}</aside><section id="items-panel" class="items-panel panel" data-scroll aria-label="待复核事项">${itemsMarkup(p)}</section><section id="detail-panel" class="detail-panel panel" data-scroll aria-label="事项复核详情" tabindex="-1">${detailMarkup()}</section></div>`;
}
function overviewMarkup(p) {
  const confirmed = p.findings.filter(isConfirmed).length;
  const blocked = p.findings.filter(f => !canReview(f) && f.status !== 'rejected' || f.status === 'confirmed' && !isConfirmed(f)).length;
  const pending = p.findings.filter(f => f.status === 'pending' || f.status === 'confirmed' && !isConfirmed(f)).length;
  const total = p.findings.length;
  const ratio = total ? Math.round(confirmed / total * 100) : 0;
  return `<section id="overview-panel" class="overview" data-scroll aria-label="项目概览"><div class="summary-card"><span class="summary-label">资料</span><strong>${p.documents.length}<small>份文档</small></strong><p>${p.documents.reduce((n, d) => n + d.page_count, 0)} 页原文可查</p></div><button class="summary-card summary-button" data-action="filter-pending"><span class="summary-label">等待复核</span><strong>${pending}<small>个事项</small></strong><p>${blocked ? `${blocked} 个事项还需补充或修正` : total ? '逐项检查来源与可比口径' : '导入 Agent 候选后开始'}</p></button><div class="summary-card"><span class="summary-label">已确认</span><strong>${confirmed}<small>/ ${total} 个事项</small></strong><div class="progress-track" role="progressbar" aria-label="复核完成度" aria-valuemin="0" aria-valuemax="${Math.max(total, 1)}" aria-valuenow="${confirmed}"><i style="width:${ratio}%"></i></div></div><div class="overview-note"><span class="eyebrow">复核顺序</span><p><b>原文</b><span>→</span><b>可比口径</b><span>→</span><b>计算</b><span>→</span><b>确认</b></p><small>来源匹配通过，仍需你核对列、期间和主体。</small></div></section>`;
}
function sourceMarkup(p) {
  const doc = p.documents.find(d => d.id === state.documentId);
  const page = doc?.pages.find(p => p.number === Number(state.page));
  const f = currentFinding();
  const quote = [f?.current, f?.prior].find(v => v?.document_id === doc?.id && Number(v?.page) === Number(state.page))?.quote;
  let text = esc(page?.text || '这一页没有可提取的文字。若为扫描图像，请先在其他工具中完成 OCR，再导入文字文档。');
  if (quote && page?.text.includes(quote)) { const index = page.text.indexOf(quote); text = `${esc(page.text.slice(0, index))}<mark>${esc(quote)}</mark>${esc(page.text.slice(index + quote.length))}`; }
  return `<div class="panel-heading"><span class="section-number">01</span><h2>原文</h2>${doc ? `<button class="text-button" data-action="open-original">原文件 ↗</button>` : ''}</div>${!doc ? `<div class="panel-empty"><div class="empty-symbol">文</div><h3>还没有资料</h3><p>添加 PDF、TXT 或 CSV。每份原文都保留独立的文档编号。</p><button data-action="import-document">导入文档</button></div>` : `<div class="source-controls"><label for="document-select">文档</label><select id="document-select">${p.documents.map(d => `<option value="${esc(d.id)}" ${d.id === doc.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select><div class="page-control"><label for="page-select">页码</label><select id="page-select">${doc.pages.map(p => `<option value="${p.number}" ${p.number === Number(state.page) ? 'selected' : ''}>第 ${p.number} 页</option>`).join('')}</select><span>共 ${doc.page_count} 页</span></div></div>${doc.warnings?.length ? `<div class="inline-warning">${doc.warnings.map(esc).join('<br>')}</div>` : ''}<div class="document-meta"><span>${esc(doc.type.toUpperCase())}</span><code title="文档编号">${esc(doc.id)}</code></div><pre class="source-text">${text}</pre><details class="hash-details"><summary>文件校验信息</summary><p>原文件 SHA-256</p><code>${esc(doc.sha256)}</code></details>`}`;
}
function itemsMarkup(p) {
  const findings = p.findings.filter(f => (state.filter === 'all' || state.filter === 'blocked' && ((!canReview(f) && f.status !== 'rejected') || (f.status === 'confirmed' && !isConfirmed(f))) || state.filter === 'confirmed' && isConfirmed(f) || state.filter === 'pending' && (f.status === 'pending' || f.status === 'confirmed' && !isConfirmed(f)) || state.filter === 'rejected' && f.status === 'rejected') && `${f.label} ${f.metric} ${f.id}`.toLowerCase().includes(state.query.toLowerCase()));
  return `<div class="panel-heading"><span class="section-number">02</span><h2>事项</h2><span class="count">${p.findings.length}</span></div><div class="queue-tools"><label class="sr-only" for="finding-search">搜索事项</label><input id="finding-search" type="search" placeholder="搜索指标或编号" value="${esc(state.query)}"><label class="sr-only" for="status-filter">筛选状态</label><select id="status-filter"><option value="all" ${state.filter === 'all' ? 'selected' : ''}>全部状态</option>${[['pending', '待复核'], ['blocked', '待补充'], ['confirmed', '已确认'], ['rejected', '已驳回']].map(([v, l]) => `<option value="${v}" ${state.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="finding-list">${findings.length ? findings.map(f => `<button class="finding-card ${f.id === state.findingId ? 'selected' : ''}" data-finding-id="${esc(f.id)}" aria-pressed="${f.id === state.findingId}"><span class="finding-top"><span class="finding-id" title="${esc(f.id)}">${esc(shortId(f.id))}</span>${badge(f)}</span><strong>${esc(f.label)}</strong><span class="finding-value">${esc(numberText(f.current?.value))}<small>${esc(f.current?.unit || '')}</small></span><span class="finding-sub">${esc(display(f.current?.period_end, '期间待补充'))}<b>·</b>${esc(display(f.current?.entity, '主体待补充'))}</span></button>`).join('') : `<div class="panel-empty compact"><h3>${p.findings.length ? '没有符合条件的事项' : '还没有复核事项'}</h3><p>${p.findings.length ? '试着换一个搜索词，或清除筛选。' : 'Agent 整理的候选 JSON 会进入这里，初始状态均为待复核。'}</p><button data-action="${p.findings.length ? 'clear-filter' : 'import-agent'}">${p.findings.length ? '清除筛选' : '导入 Agent 候选'}</button></div>`}</div>`;
}
function detailMarkup() {
  const f = currentFinding();
  if (!f) return `<div class="panel-heading"><span class="section-number">03</span><h2>复核</h2></div><div class="detail-empty"><span class="empty-symbol">核</span><h3>让每一项判断都有出处。</h3><p>选择一个事项，在这里对照原文、检查计算，再留下你的复核结论。</p><div class="review-outline"><span>核对原文</span><span>检查口径</span><span>确认记录</span></div></div>`;
  const c = f.calculation || {};
  const reasons = f.checks?.filter(c => c.state !== 'pass') || [];
  return `<div class="panel-heading"><span class="section-number">03</span><h2>复核</h2><span class="detail-version">工作副本 v${esc(f.version)}</span></div><div class="detail-title"><div><span class="eyebrow">${esc(f.metric)} · ${esc(shortId(f.id))}</span><h3>${esc(f.label)}</h3></div>${badge(f)}</div>
    <section class="detail-section"><div class="section-heading"><h4>原文与工作副本</h4><button class="text-button" data-action="edit-finding">修改数据与口径</button></div><div class="comparison-grid">${inputMarkup(f.current, 'current', '本期')}${inputMarkup(f.prior, 'prior', '上期')}</div></section>
    <section class="detail-section"><div class="section-heading"><h4>计算结果</h4><span class="small-note">按元统一 · 精确小数计算</span></div><div class="calculation"><div><span>本期金额</span><strong>${esc(numberText(c.current_cny))}<small>元</small></strong></div><div><span>上期金额</span><strong>${esc(numberText(c.prior_cny))}<small>元</small></strong></div><div><span>增减额</span><strong>${esc(numberText(c.difference_cny))}<small>元</small></strong></div><div class="calculation-percent"><span>同比变化</span><strong>${c.percent == null ? '—' : `${esc(c.percent)}<small>%</small>`}</strong></div></div><p class="formula">（本期 − 上期）÷ 上期 × 100%</p>${c.percent == null ? `<p class="inline-note">${Number(c.prior_cny) <= 0 && c.prior_cny != null ? '上期为零或负数，只展示可计算的增减额，不给出常规同比百分比。' : '资料或可比条件不足时，不展示同比百分比。'}</p>` : ''}</section>
    <section class="detail-section"><div class="section-heading"><h4>来源与可比性检查</h4><span class="small-note">${f.checks?.filter(c => c.state === 'pass').length || 0} / ${f.checks?.length || 0} 项通过</span></div><ul class="checks">${(f.checks || []).map(check => `<li class="check-${esc(check.state)}"><span class="check-icon" aria-hidden="true">${check.state === 'pass' ? '✓' : check.state === 'fail' ? '×' : '?'}</span><div><strong>${esc(check.label)}</strong><p>${esc(check.reason)}</p></div><span class="check-state">${check.state === 'pass' ? '通过' : check.state === 'fail' ? '不通过' : '待核对'}</span></li>`).join('')}</ul></section>
    <section class="review-section"><div class="section-heading"><h4>人工复核</h4>${isConfirmed(f) ? '<span class="badge confirmed">已写入事实记录</span>' : ''}</div>${isConfirmed(f) ? `<div class="confirmed-note"><strong>该版本已经人工确认</strong><p>修改数据或恢复初始候选后，需要重新核对并确认。</p></div>` : f.status === 'confirmed' ? `<div class="inline-warning">原确认已失效，当前版本不会进入事实记录。请重新打开，检查来源和口径后再次确认。</div>` : f.status === 'rejected' ? `<div class="inline-warning">此事项已驳回，不会进入事实记录。重新打开后可继续修改和复核。</div>` : `<label class="attestation"><input id="human-attestation" type="checkbox" ${!canReview(f) ? 'disabled' : ''}><span>我已对照原文，核对数值所在列、主体、统计范围和期间，确认两期可以比较。</span></label>${!canReview(f) ? `<p class="blocked-reason">尚有 ${reasons.length} 项检查未通过或待核对。先修正数据与来源，再进行人工确认。</p>` : '<p class="inline-note">文字匹配只说明来源可追溯，不能代替对表格含义的判断。</p>'}`}
      <label class="field-label" for="review-note">复核备注 <span>确认选填，驳回必填</span></label><textarea id="review-note" rows="2" placeholder="记录判断依据、驳回原因或需要继续核对的地方">${esc(state.noteDrafts[noteKey(f.id)] ?? f.note ?? '')}</textarea><div class="review-actions">${f.status === 'pending' ? `<button class="primary" data-action="confirm" disabled>确认并写入记录</button><button data-action="reject">驳回事项</button>` : `<button class="primary" data-action="reopen">重新打开复核</button>`}<button class="text-button" data-action="restore">恢复初始候选</button></div></section>
    <details class="audit-trail"><summary>操作记录 <span>${state.project.events.filter(e => !e.finding_id || e.finding_id === f.id).length}</span></summary><p class="record-id">事项编号 <code>${esc(f.id)}</code></p><ol>${state.project.events.filter(e => !e.finding_id || e.finding_id === f.id).slice().reverse().map(e => `<li><time>${esc(dateText(e.at))}</time><p>${esc(e.detail)}</p><small>${e.actor === 'agent' ? 'Agent' : '浏览器'} · ${esc(e.action)}</small></li>`).join('')}</ol></details>`;
}
function inputMarkup(input = {}, key, label) {
  const doc = state.project.documents.find(d => d.id === input.document_id);
  return `<article class="input-card"><div class="input-card-top"><h5>${label}</h5><button class="text-button" data-action="locate-source" data-side="${key}" ${!doc ? 'disabled' : ''}>查看原文 ↗</button></div><div class="input-amount">${esc(numberText(input.value))}<small>${esc(input.unit || '单位未提供')}</small></div><dl><div><dt>期间</dt><dd>${esc(display(input.period_start))} — ${esc(display(input.period_end))}</dd></div><div><dt>类型</dt><dd>${input.period_type === 'flow' ? '期间数' : input.period_type === 'instant' ? '时点数' : '未提供'}</dd></div><div><dt>主体</dt><dd>${esc(display(input.entity))}</dd></div><div><dt>范围 / 币种</dt><dd>${esc(display(input.scope))} / ${esc(display(input.currency))}</dd></div></dl><blockquote>${esc(display(input.quote, '尚未提供对应原文'))}</blockquote><p class="source-reference">${esc(doc?.name || '文档待补充')} · 第 ${esc(input.page || '—')} 页</p></article>`;
}

function openDialog(title, content, options = {}) {
  dialogRoot.innerHTML = `<dialog class="modal ${options.wide ? 'wide-modal' : ''}" aria-labelledby="dialog-title"><div class="modal-heading"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="关闭对话框">×</button></div><div class="modal-content">${content}</div></dialog>`;
  const dialog = dialogRoot.querySelector('dialog');
  dialog.addEventListener('close', () => { dialogRoot.innerHTML = ''; });
  dialog.showModal();
}
function closeDialog() { dialogRoot.querySelector('dialog')?.close(); }
function newProjectDialog() {
  openDialog('新建项目', `<form id="new-project-form"><p class="dialog-lead">按一家公司、一份任务或一组资料建立项目。</p><label class="field-label" for="project-name">项目名称</label><input id="project-name" name="name" maxlength="120" required placeholder="例如：年度报告复核" autofocus><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button class="primary" type="submit">创建项目</button></div></form>`);
}
function documentDialog() {
  openDialog('导入文档', `<form id="document-form"><p class="dialog-lead">原文件和提取的文字会保留在当前本地项目中。</p><label class="upload-field" for="document-file"><strong>选择 PDF、TXT 或 CSV</strong><span>PDF 最多 20 MB、100 页。仅支持可提取文字的 PDF；不会自动进行 OCR。</span><input id="document-file" type="file" accept=".pdf,.txt,.csv" required aria-label="选择文档"></label><p class="inline-note">TXT 和 CSV 请使用 UTF-8 编码。一次导入一份文档。</p><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button class="primary" type="submit">导入文档</button></div></form>`);
}
function importDialog() {
  openDialog('导入 Agent 候选', `<form id="agent-form"><p class="dialog-lead">导入结构化候选，不会触发模型调用，也不会自动确认。文档编号和页码必须指向本项目的原文。</p><label class="field-label" for="agent-file">Agent JSON 文件 <span>或在下方粘贴</span></label><input id="agent-file" type="file" accept=".json,application/json" aria-label="Agent JSON文件"><label class="field-label" for="agent-json">候选 JSON</label><textarea id="agent-json" rows="8" spellcheck="false" placeholder='{"schema_version":"1.0","expected_revision":0,"findings":[…]}'></textarea><details class="import-reference"><summary>本项目的文档编号</summary><ul>${state.project.documents.map(d => `<li><strong>${esc(d.name)}</strong><code>${esc(d.id)}</code><span>${d.page_count} 页</span></li>`).join('') || '<li>先导入文档，再让 Agent 引用对应的文档编号。</li>'}</ul></details><p class="inline-note">候选文件须保留 Agent 读取资料时的 expected_revision。项目更新后请重新读取并核对，不要只改版本号。已有同编号事项被替换后，需要重新人工确认。</p><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button class="primary" type="submit">导入候选</button></div></form>`, { wide: true });
}
function editDialog() {
  const f = currentFinding();
  if (!f) return;
  openDialog('修改数据与口径', `<form id="edit-form"><p class="dialog-lead">这里只修改工作副本。原文件和初始候选会保留；保存后需重新复核。</p><label class="field-label" for="finding-label">事项名称</label><input id="finding-label" name="label" value="${esc(f.label)}" required><div class="edit-columns">${editInput(f.current, 'current', '本期')}${editInput(f.prior, 'prior', '上期')}</div><label class="field-label" for="edit-note">修改说明</label><textarea id="edit-note" name="note" rows="2" required placeholder="说明改了什么，以及依据是什么"></textarea><div class="dialog-actions"><button type="button" data-action="close-dialog">取消</button><button class="primary" type="submit">保存工作副本</button></div></form>`, { wide: true });
}
function editInput(input = {}, side, title) {
  const field = (name, label, options = {}) => `<label class="edit-field ${options.full ? 'full' : ''}"><span>${label}</span><input name="${side}.${name}" type="${options.type || 'text'}" ${options.type === 'number' ? 'min="1" step="1"' : ''} value="${esc(input[name] ?? '')}" ${options.placeholder ? `placeholder="${esc(options.placeholder)}"` : ''}></label>`;
  return `<fieldset><legend>${title}</legend><div class="edit-fields"><label class="edit-field full"><span>来源文档</span><select name="${side}.document_id"><option value="">未选择</option>${state.project.documents.map(d => `<option value="${esc(d.id)}" ${d.id === input.document_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>${field('page', '原文页码', { type: 'number' })}${field('value', '数值', { placeholder: '原文金额，不含千分位' })}<label class="edit-field"><span>金额单位</span><select name="${side}.unit">${['', '元', '万元', '亿元'].map(u => `<option value="${u}" ${u === input.unit ? 'selected' : ''}>${u || '未提供'}</option>`).join('')}</select></label>${field('currency', '币种', { placeholder: '例如 CNY' })}${field('entity', '主体', { full: true })}${field('scope', '统计范围', { full: true })}${field('period_start', '起始日期', { type: 'date' })}${field('period_end', '结束日期', { type: 'date' })}<label class="edit-field full"><span>期间类型</span><select name="${side}.period_type">${[['', '未提供'], ['flow', '期间数（如年度收入）'], ['instant', '时点数（如期末余额）']].map(([v, l]) => `<option value="${v}" ${v === input.period_type ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="edit-field full"><span>原文摘录</span><textarea name="${side}.quote" rows="4">${esc(input.quote || '')}</textarea></label></div></fieldset>`;
}
function exportDialog() {
  const confirmed = state.project.findings.filter(isConfirmed).length;
  openDialog('导出复核记录', `<p class="dialog-lead">当前有 <strong>${confirmed}</strong> 条已确认事实。尚未确认、被阻断或驳回的事项会与事实分开。</p><div class="export-options">${[['markdown', 'Markdown', '便于阅读的复核报告，含待处理事项。'], ['json', 'JSON', '结构化结果、来源与待处理事项。'], ['csv', 'CSV', '仅导出已确认事实，便于表格处理。']].map(([format, title, text]) => `<button data-action="export" data-format="${format}"><strong>${title}</strong><span>${text}</span><b aria-hidden="true">↓</b></button>`).join('')}</div>`);
}
function projectDialog() {
  openDialog('项目管理', `<div class="project-facts"><h3>${esc(state.project.name)}</h3><p>${state.project.documents.length} 份文档 · ${state.project.findings.length} 个事项</p><code>${esc(state.project.id)}</code></div><div class="danger-zone"><h3>删除这个项目</h3><p>将删除本项目的原文件、候选和复核记录。不会影响其他项目。</p><button class="danger" data-action="delete-project-prompt">删除项目…</button></div>`);
}
function helpDialog() {
  openDialog('如何与 Agent 配合', `<ol class="help-steps"><li><strong>先导入原文件</strong><p>在本地建立项目并导入文档。工作台提供按页文本和独立的文档编号。</p></li><li><strong>让 Agent 整理候选</strong><p>通过配套 CLI 或本地 API 读取项目资料，按候选格式整理两期数值、出处和可比口径。详细命令见项目 README。</p></li><li><strong>回到这里复核</strong><p>导入 Agent 输出的 JSON。检查原文、修正差错，再手动勾选确认。Agent 不能替你完成确认。</p></li></ol><p class="inline-warning">这里不连接模型、不需要 API Key。把资料交给外部 Agent 时，资料处理方式取决于你使用的 Agent。</p>${state.project ? `<p class="field-label">当前项目编号</p><code class="copy-value">${esc(state.project.id)}</code>` : ''}`);
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
async function download(format) {
  const response = await api(`${projectPath()}/export?format=${enc(format)}`, { raw: true });
  const blob = await response.blob();
  const extension = format === 'markdown' ? 'md' : format;
  const name = `${state.project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-复核记录.${extension}`;
  saveBlob(blob, name);
  closeDialog(); notice(`已导出 ${format.toUpperCase()} 复核记录。`);
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function selectFinding(id) {
  state.findingId = id;
  const f = currentFinding();
  if (f?.current?.document_id) { state.documentId = f.current.document_id; state.page = f.current.page; }
  syncSelection(); state.tab = 'detail'; render();
  const detail = document.getElementById('detail-panel'); if (detail) { detail.scrollTop = 0; detail.focus({ preventScroll: true }); }
}
async function review(action) {
  const f = currentFinding(); if (!f) return;
  const note = document.getElementById('review-note')?.value.trim() || '';
  if (action === 'reject' && !note) throw new Error('请先填写驳回原因，再驳回此事项。');
  const attested = document.getElementById('human-attestation')?.checked;
  updateProject(await api(`${projectPath()}/findings/${enc(f.id)}/review`, { method: 'POST', body: { expected_revision: state.project.revision, action, note, ...(action === 'confirm' ? { attested: !!attested } : {}) } }));
  delete state.noteDrafts[noteKey(f.id)];
  notice({ confirm: '当前版本已人工确认，可在导出的事实记录中查看。', reject: '事项已驳回，已从事实记录中排除。', reopen: '已重新打开，需重新核对并确认。', restore: '已恢复初始候选；旧确认已失效，请重新复核。' }[action]);
}

document.addEventListener('click', event => {
  const finding = event.target.closest('[data-finding-id]');
  if (finding && !state.busy) { selectFinding(finding.dataset.findingId); return; }
  const tab = event.target.closest('[data-mobile-tab]');
  if (tab?.tagName === 'BUTTON' && !state.busy) { state.tab = tab.dataset.mobileTab; render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'close-dialog') { closeDialog(); return; }
  if (action === 'dismiss-notice') { state.notice = null; render(); return; }
  if (state.busy) return;
  const dialogs = { 'new-project': newProjectDialog, 'import-document': documentDialog, 'import-agent': importDialog, 'edit-finding': editDialog, 'export-menu': exportDialog, 'project-menu': projectDialog, help: helpDialog };
  if (dialogs[action]) { dialogs[action](); return; }
  if (action === 'clear-filter') { state.query = ''; state.filter = 'all'; render(); return; }
  if (action === 'filter-pending') { state.filter = 'pending'; state.query = ''; state.tab = 'items'; render(); return; }
  if (action === 'locate-source') {
    const input = currentFinding()?.[button.dataset.side]; if (!input) return;
    state.documentId = input.document_id; state.page = input.page; state.tab = 'sources'; syncSelection(); render();
    const source = document.getElementById('source-panel'); source.scrollTop = 0; return;
  }
  if (action === 'delete-project-prompt') {
    openDialog('确认删除项目', `<p class="dialog-lead">确定删除“${esc(state.project.name)}”及其全部文档和复核记录？此操作无法撤销。</p><div class="dialog-actions"><button data-action="close-dialog">保留项目</button><button class="danger" data-action="delete-project">确认删除</button></div>`); return;
  }
  if (action === 'restore') {
    openDialog('恢复初始候选', `<p class="dialog-lead">将恢复最初导入的数值、原文和口径。当前人工确认会失效，之后需要重新复核。</p><div class="dialog-actions"><button data-action="close-dialog">取消</button><button class="primary" data-action="restore-confirmed">恢复初始候选</button></div>`); return;
  }
  run(async () => {
    if (action === 'refresh-project') { updateProject(await api(projectPath())); notice('已加载项目最新版本。'); }
    else if (['confirm', 'reject', 'reopen'].includes(action)) await review(action);
    else if (action === 'restore-confirmed') { closeDialog(); await review('restore'); }
    else if (action === 'export') await download(button.dataset.format);
    else if (action === 'open-original') {
      const doc = state.project.documents.find(d => d.id === state.documentId);
      const response = await api(`${projectPath()}/documents/${enc(doc.id)}/file`, { raw: true });
      saveBlob(await response.blob(), doc.name); notice(`已下载原文件：${doc.name}`);
    } else if (action === 'delete-project') {
      const id = state.project.id;
      await api(projectPath(), { method: 'DELETE', body: { expected_revision: state.project.revision } });
      state.projects = state.projects.filter(p => p.id !== id); state.project = null; closeDialog();
      if (state.projects.length) await loadProject(state.projects[0].id);
      notice('项目及其文档已删除。');
    } else if (action === 'load-sample') {
      const response = await fetch('/sample-data.json'); if (!response.ok) throw new Error('构造样例尚未准备好，请先新建项目。');
      const sample = await response.json();
      updateProject(await api('/api/projects', { method: 'POST', body: { name: sample.name } }));
      const file = new File([sample.document.text], sample.document.name, { type: 'text/plain' });
      updateProject(await api(`${projectPath()}/documents`, { method: 'POST', body: { name: file.name, content_base64: await fileBase64(file) } }));
      const docId = state.project.documents.at(-1).id;
      const findings = sample.findings.map(f => ({ ...f, current: { ...f.current, document_id: f.current.document_id === '__DOCUMENT__' ? docId : f.current.document_id }, prior: { ...f.prior, document_id: f.prior.document_id === '__DOCUMENT__' ? docId : f.prior.document_id } }));
      updateProject(await api(`${projectPath()}/import`, { method: 'POST', body: { schema_version: '1.0', expected_revision: state.project.revision, findings } }));
      state.tab = 'items'; notice('已载入构造样例。它只用于体验复核流程，不是真实公司数据。');
    }
  });
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'project-select' && el.value) run(async () => { await loadProject(el.value); state.notice = null; });
  if (el.id === 'document-select') { state.documentId = el.value; state.page = 1; syncSelection(); render(); document.getElementById('source-panel').scrollTop = 0; }
  if (el.id === 'page-select') { state.page = Number(el.value); render(); }
  if (el.id === 'status-filter') { state.filter = el.value; render(); }
  if (el.id === 'human-attestation') { const confirm = document.querySelector('[data-action="confirm"]'); if (confirm) confirm.disabled = !el.checked || !canReview(currentFinding() || {}); }
  if (el.id === 'agent-file' && el.files[0]) { el.files[0].text().then(text => { const field = document.getElementById('agent-json'); if (field) field.value = text; }).catch(() => { notice('无法读取 JSON 文件。', 'error'); render(); }); }
});
document.addEventListener('input', event => {
  if (event.target.id === 'review-note' && currentFinding()) state.noteDrafts[noteKey(currentFinding().id)] = event.target.value;
  if (event.target.id === 'finding-search') {
    const value = event.target.value; const position = event.target.selectionStart;
    state.query = value; render(); const input = document.getElementById('finding-search'); input.focus({ preventScroll: true }); try { input.setSelectionRange(position, position); } catch {}
  }
});
document.addEventListener('submit', event => {
  event.preventDefault(); if (state.busy) return;
  const form = event.target;
  run(async () => {
    if (form.id === 'new-project-form') {
      updateProject(await api('/api/projects', { method: 'POST', body: { name: new FormData(form).get('name').trim() } }));
      closeDialog(); state.tab = 'items'; notice('项目已创建。先导入一份文档。');
    } else if (form.id === 'document-form') {
      const file = document.getElementById('document-file').files[0]; if (!file) throw new Error('请先选择文档。');
      if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MB，请缩小后再导入。');
      updateProject(await api(`${projectPath()}/documents`, { method: 'POST', body: { name: file.name, content_base64: await fileBase64(file) } }));
      state.documentId = state.project.documents.at(-1)?.id; state.page = 1; state.tab = 'sources'; closeDialog(); notice(`已导入 ${file.name}。请检查提取的原文。`);
    } else if (form.id === 'agent-form') {
      let data; try { data = JSON.parse(document.getElementById('agent-json').value); } catch { throw new Error('JSON 格式不正确，请检查引号、逗号和括号。'); }
      if (!data || data.schema_version !== '1.0' || !Array.isArray(data.findings)) throw new Error('候选 JSON 需要 schema_version: "1.0" 和 findings 数组。');
      if (!Number.isInteger(data.expected_revision) || data.expected_revision < 0) throw new Error('候选 JSON 缺少有效的 expected_revision。请让 Agent 通过 context 命令读取项目版本，再核对并生成候选文件。');
      updateProject(await api(`${projectPath()}/import`, { method: 'POST', body: data }));
      state.tab = 'items'; closeDialog(); notice(`已导入 ${data.findings.length} 个候选。所有变更都需要人工复核。`);
    } else if (form.id === 'edit-form') {
      const values = new FormData(form); const getInput = side => Object.fromEntries(['document_id', 'page', 'quote', 'value', 'unit', 'currency', 'entity', 'scope', 'period_start', 'period_end', 'period_type'].map(key => { const value = String(values.get(`${side}.${key}`) || '').trim(); return [key, key === 'page' ? value ? Number(value) : null : key === 'value' ? value || null : value]; }));
      updateProject(await api(`${projectPath()}/findings/${enc(currentFinding().id)}`, { method: 'PATCH', body: { expected_revision: state.project.revision, label: values.get('label').trim(), current: getInput('current'), prior: getInput('prior'), note: values.get('note').trim() } }));
      delete state.noteDrafts[noteKey(currentFinding().id)]; closeDialog(); notice('工作副本已保存，请重新核对并确认。');
    }
  });
});

async function init() {
  try {
    const session = await api('/api/session'); state.token = session.csrf_token; state.projects = session.projects;
    let saved; try { saved = localStorage.getItem('filing-review-project'); } catch {}
    if (state.projects.length) await loadProject(state.projects.some(p => p.id === saved) ? saved : state.projects[0].id);
  } catch (error) { notice(`未能连接本地服务：${error.message}。请确认服务仍在运行后刷新页面。`, 'error'); }
  render();
}
init();
