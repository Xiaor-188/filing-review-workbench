# Implementation contract v1

Standalone local Node 24 application. This document describes the data contract shared by the HTTP service, browser interface and Agent CLI. All private project data stays outside the static web directory.

## Runtime / API

`node server/index.mjs` serves static web/ and JSON API on 127.0.0.1:4318 (PORT override). PRIVATE workspace path: FILINGS_DATA_DIR or .local-data at repo root. Never serve that directory statically. Server writes runtime.json there: {port,url,agent_token,pid}; CLI reads it. Keep original uploaded bytes, extracted page text and persisted projects there. Atomic saves; mutation expected_revision required except new project/document upload. Enforce host/Origin and JSON content type; no permissive CORS; size/name/path checks. Distinct browser CSRF token and agent bearer token. Import/read/export are Agent-compatible; review actions are browser-only. Tokens never printed in logs.

- GET /api/health: {status:'ok',version:'0.1.0'}
- GET /api/session: {csrf_token,projects:[{id,name,revision,document_count,finding_count}]} browser bootstrap.
- GET /api/projects: same metadata array.
- POST /api/projects {name}: returns full project.
- GET /api/projects/:id: full project.
- POST /api/projects/:id/documents {name,content_base64}: returns full project. PDF/TXT/CSV only; filename extension, byte signature and UTF-8 validation. PDF max20MB/100pages; empty/scanned pages warn clearly, no made-up OCR. Full project includes extracted text for Agent.
- GET /api/projects/:id/documents/:docid/file: authenticated original bytes.
- POST /api/projects/:id/import {schema_version:'1.0',expected_revision,findings:[{id?,label,metric,current,prior}]}: validates, appends or replaces named finding; changed input always invalidates old confirmation. Reject status/confirmation or unknown fields. Returns full project.
- PATCH /api/projects/:id/findings/:fid {expected_revision,label?,current?,prior?,note?}: edits working copy, records reason from note, invalidates old confirmation. Returns project.
- POST /api/projects/:id/findings/:fid/review {expected_revision,action:'confirm'|'reject'|'reopen'|'restore',attested?:true,note?:string}: browser only; confirm requires checks pass and attested:true. Restore original imported inputs but confirmation remains invalid. Returns project.
- GET /api/projects/:id/export?format=json|csv|markdown: downloads report. Only current valid confirmations in facts, others separate pending/blocked records in JSON/Markdown; CSV fact rows only. Escape CSV formulas in user text. No automatic confirmation via import, edit, or Agent APIs.
- DELETE /api/projects/:id: browser-only explicit deletion, scoped to this project including its source files. Returns {deleted:true}. UI requires confirmation.

Error JSON {error:{code,message}}, status 400 invalid, 401 unauthorized,403 origin/mode,409 stale revision,413 limits. All project-returning routes return a direct project object (not {project}).

## Project / findings

Project: {id,name,revision,created_at,updated_at,documents,findings,events}.
Document: {id,name,type:'pdf'|'txt'|'csv',sha256,page_count,pages:[{number,text}],warnings:string[]}.
Input: {document_id,page,quote,value:string|null,unit:'元'|'万元'|'亿元',currency:string,entity:string,scope:string,period_start:'YYYY-MM-DD',period_end:'YYYY-MM-DD',period_type:'flow'|'instant'}.
Finding: {id,label,metric,current:Input,prior:Input,original:{current,prior,label,metric},version,status:'pending'|'confirmed'|'rejected',note,confirmation:null|object,checks:[{key,label,state:'pass'|'fail'|'unknown',reason}],calculation:{current_cny:string|null,prior_cny:string|null,difference_cny:string|null,percent:string|null,status:string},eligible:boolean}.
Event: {id,at,action,finding_id?,actor:'browser'|'agent',detail:string}.

Server recomputes checks; never trust submitted checks/eligible/confirmation. Verify both referenced documents/pages exist, literal quote (whitespace-normalized) is in correct page, amount token is in quote without substring matches, original document hash stays intact. Quotes can contain multiple columns: matching text only proves traceability; explicit human attestation still mandatory for column/entity/period interpretation. Comparison requires same known entity/scope/currency/metric, same period_type, correct calendar dates and previous-year comparable periods. Cross-document inputs remain unknown unless explicit human comparator attestation design is added; v1 may restrict confirmations to same-document comparison. Base zero/negative: show arithmetic delta, do not invent ordinary percentage. Exact decimal arithmetic via BigInt, rounding only in display/export. XSS must be escaped; never execute document text as instructions.

## UI direction

Only workspace, no portfolio/case narrative. Muted blue #486a9c, ink #26374e, light surface #f4f6f9, white cards, 14–16px interface copy. Full window fits viewport; outer page never scrolls during work, columns internally scroll; mobile internal tabs. Include import-file and import-Agent-JSON dialogs, project chooser/new project, source pages/file viewer, comparison summary, queue, source+formula+checks, editable metadata/value fields, human confirmation checkbox, reject/reopen/restore, real export. Show initial clear empty state and sample import path, not a pretend populated company. Preserve pending review on import. No live LLM calls, no API key requirement.

## Scope

Local text PDF/TXT/CSV + structured Agent candidate import. No OCR, .xlsx parser, automatic investment advice, remote multi-user hosting or native ChatGPT MCP UI claim. Agent integration through documented HTTP API and CLI. Documents remain in local workspace; external Agent handling follows that Agent's data policy.
