import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, realpath, stat, rm } from 'node:fs/promises';
import { dirname, resolve, join, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiError, fail, exactFields } from './errors.mjs';
import { ProjectStore, atomicWrite } from './store.mjs';
import { parseDocument, MAX_BYTES } from './documents.mjs';
import { importFindings, editFinding, reviewFinding, exportRecord, serializeReport } from './domain.mjs';

const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.woff2':'font/woff2'};
const FILE_MIME={pdf:'application/pdf',txt:'text/plain; charset=utf-8',csv:'text/csv; charset=utf-8'};
const safeEqual=(a,b)=>{if(typeof a!=='string'||typeof b!=='string')return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);};
function cookies(header=''){return Object.fromEntries(header.split(';').map(part=>{const pos=part.indexOf('=');return pos<0?['','']:[part.slice(0,pos).trim(),part.slice(pos+1).trim()];}));}
function sendJson(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(data));}
async function body(req,max=2*1024*1024){
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||''))fail(400,'json_required','此接口仅接受 Content-Type: application/json。');
  const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>max)fail(413,'request_too_large','请求超过大小限制。');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'request_too_large','请求超过大小限制。');chunks.push(chunk);}
  let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail(400,'invalid_json','请求不是有效的 UTF-8 JSON。');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail(400,'invalid_object','请求必须是 JSON 对象。');
  return parsed;
}
function checkRequest(req,port){
  const allowed=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  if(!allowed.has(req.headers.host))fail(403,'host_not_allowed','仅接受本机工作台 Host。');
  const remote=req.socket.remoteAddress;if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(remote))fail(403,'local_only','此工作台只接受本机连接。');
  const parsed=new URL(req.url,`http://${req.headers.host}`);
  const topNavigation=['GET','HEAD'].includes(req.method)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document'&&!parsed.pathname.startsWith('/api/');
  if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`&&!topNavigation)fail(403,'origin_not_allowed','跨来源请求已拒绝。');
  if(req.headers['sec-fetch-site']==='cross-site'&&!topNavigation)fail(403,'origin_not_allowed','跨站请求已拒绝。');
  let decoded;
  try{decoded=decodeURIComponent((req.url||'/').split('?')[0]);}catch{fail(400,'invalid_path','URL 编码无效。');}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').some(part=>part==='..'||part==='.')||/%(?:2e|2f|5c)/i.test(decoded))fail(400,'invalid_path','路径包含不允许的片段。');
  return parsed;
}
function auth(req,{agentToken,browserToken,csrfToken},mutation=false){
  const authorization=req.headers.authorization;
  if(authorization!==undefined){if(!authorization.startsWith('Bearer ')||!safeEqual(authorization.slice(7),agentToken))fail(401,'unauthorized','Agent Bearer 令牌无效。');return 'agent';}
  if(!safeEqual(cookies(req.headers.cookie).fr_session,browserToken))fail(401,'unauthorized','浏览器会话未建立，请刷新工作台。');
  if(mutation&&!safeEqual(req.headers['x-csrf-token'],csrfToken))fail(403,'csrf_required','浏览器写入缺少有效 CSRF token，请刷新后重试。');
  return 'browser';
}
async function staticFile(req,res,pathname,webDir){
  if(!['GET','HEAD'].includes(req.method))fail(405,'method_not_allowed','静态资源只允许读取。');
  const relative=pathname==='/'?'index.html':decodeURIComponent(pathname).replace(/^\//,'');
  const target=resolve(webDir,relative),boundary=resolve(webDir)+sep;
  if(!target.startsWith(boundary))fail(404,'not_found','资源不存在。');
  let canonical;try{canonical=await realpath(target);}catch{fail(404,'not_found','资源不存在。');}
  if(!canonical.startsWith(boundary))fail(404,'not_found','资源不存在。');
  const mime=MIME[extname(canonical).toLowerCase()];if(!mime||!(await stat(canonical)).isFile())fail(404,'not_found','资源不存在。');
  res.setHeader('Content-Type',mime);res.statusCode=200;res.end(req.method==='HEAD'?undefined:await readFile(canonical));
}

export async function startServer({port=Number(process.env.PORT||4318),dataDir=process.env.FILINGS_DATA_DIR||join(REPO,'.local-data'),webDir=join(REPO,'web'),writeRuntime=true}={}){
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('PORT 必须为 0–65535 的整数。');
  const store=new ProjectStore(dataDir);await store.init();
  const tokens={agentToken:randomBytes(32).toString('base64url'),browserToken:randomBytes(32).toString('base64url'),csrfToken:randomBytes(32).toString('base64url')};
  let actualPort=port;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try{
      const url=checkRequest(req,actualPort),path=url.pathname;
      if(path==='/api/health'&&req.method==='GET')return sendJson(res,200,{status:'ok',version:'0.1.0'});
      if(path==='/api/session'&&req.method==='GET'){
        if(req.headers.authorization)fail(403,'browser_session_only','Agent 使用 Bearer 接口，不获取浏览器人工复核会话。');
        res.setHeader('Set-Cookie',`fr_session=${tokens.browserToken}; HttpOnly; SameSite=Strict; Path=/`);
        return sendJson(res,200,{csrf_token:tokens.csrfToken,projects:await store.list()});
      }
      if(!path.startsWith('/api/'))return await staticFile(req,res,path,webDir);
      const actor=auth(req,tokens,!['GET','HEAD'].includes(req.method));
      if(path==='/api/projects'){
        if(req.method==='GET')return sendJson(res,200,await store.list());
        if(req.method==='POST'){const payload=await body(req);exactFields(payload,['name'],['name']);return sendJson(res,201,await store.create(payload.name,actor));}
        fail(405,'method_not_allowed','此接口仅支持 GET、POST。');
      }
      const match=/^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);if(!match)fail(404,'not_found','接口不存在。');
      const projectId=match[1],tail=match[2]||'';
      if(!tail){
        if(req.method==='GET')return sendJson(res,200,await store.get(projectId));
        if(req.method==='DELETE'){if(actor!=='browser')fail(403,'human_delete_only','删除项目须由用户在浏览器中明确操作。');const payload=await body(req);exactFields(payload,['expected_revision'],['expected_revision']);return sendJson(res,200,await store.delete(projectId,payload.expected_revision,actor));}
        fail(405,'method_not_allowed','此接口仅支持 GET、DELETE。');
      }
      if(tail==='documents'&&req.method==='POST'){
        // Check project existence before spending work on file parsing.
        await store.get(projectId);const payload=await body(req,Math.ceil(MAX_BYTES/3)*4+2048);const parsed=await parseDocument(payload);return sendJson(res,201,await store.addDocument(projectId,parsed,actor));
      }
      const documentMatch=/^documents\/([^/]+)\/file$/.exec(tail);
      if(documentMatch&&req.method==='GET'){
        const {document,bytes}=await store.source(projectId,documentMatch[1]);
        res.setHeader('Content-Type',FILE_MIME[document.type]);
        res.setHeader('Content-Disposition',`${document.type==='pdf'?'inline':'attachment'}; filename="source.${document.type}"; filename*=UTF-8''${encodeURIComponent(document.name)}`);
        res.setHeader('Content-Length',bytes.length);res.end(bytes);return;
      }
      if(tail==='import'&&req.method==='POST'){
        const payload=await body(req);return sendJson(res,200,await store.mutate(projectId,payload.expected_revision,p=>importFindings(p,payload,actor)));
      }
      const findingMatch=/^findings\/([^/]+)(?:\/(review))?$/.exec(tail);
      if(findingMatch){
        const findingId=findingMatch[1];
        if(findingMatch[2]&&req.method==='POST'){
          if(actor!=='browser')fail(403,'human_review_only','Agent 无权执行人工复核动作；请在浏览器核对后处理。');
          const payload=await body(req);return sendJson(res,200,await store.mutate(projectId,payload.expected_revision,p=>reviewFinding(p,findingId,payload,actor)));
        }
        if(!findingMatch[2]&&req.method==='PATCH'){
          const payload=await body(req);return sendJson(res,200,await store.mutate(projectId,payload.expected_revision,p=>editFinding(p,findingId,payload,actor)));
        }
      }
      if(tail==='export'&&req.method==='GET'){
        if([...url.searchParams.keys()].some(key=>key!=='format'))fail(400,'invalid_export_query','导出只接受 format 参数。');
        const format=url.searchParams.get('format')||'json';const project=await store.get(projectId);const text=serializeReport(exportRecord(project),format);
        const extension=format==='markdown'?'md':format;
        res.setHeader('Content-Type',format==='json'?'application/json; charset=utf-8':format==='csv'?'text/csv; charset=utf-8':'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition',`attachment; filename="filing-review.${extension}"; filename*=UTF-8''${encodeURIComponent(project.name+'.'+extension)}`);res.end(text);return;
      }
      fail(404,'not_found','接口或方法不存在。');
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const known=error instanceof ApiError;sendJson(res,known?error.status:500,{error:{code:known?error.code:'internal_error',message:known?error.message:'本地服务处理失败，已保留原有项目。请重试或检查本地存储。'}});
    }
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveListen);});
  actualPort=server.address().port;const url=`http://127.0.0.1:${actualPort}`;
  const runtimePath=join(store.dataDir,'runtime.json');
  if(writeRuntime){try{await atomicWrite(runtimePath,JSON.stringify({port:actualPort,url,agent_token:tokens.agentToken,pid:process.pid},null,2)+'\n');}catch(error){await new Promise(done=>server.close(done));throw error;}}
  let closing=false;
  const close=async()=>{
    if(closing)return;closing=true;
    await new Promise(done=>server.close(done));
    if(writeRuntime){try{const runtime=JSON.parse(await readFile(runtimePath,'utf8'));if(runtime.pid===process.pid&&runtime.agent_token===tokens.agentToken)await rm(runtimePath,{force:true});}catch{}}
  };
  return {server,store,url,port:actualPort,agentToken:tokens.agentToken,close};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const app=await startServer();
    console.log(`财报复核工作台 ${app.url}`);
    console.log('资料保存在本机私有工作区；关闭此进程会停止服务。');
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
  }catch(error){console.error(error.code==='EADDRINUSE'?'端口已占用，请关闭原服务或指定 PORT。':'工作台启动失败，请检查本地目录和端口。');process.exitCode=1;}
}
