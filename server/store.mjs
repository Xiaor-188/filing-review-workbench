import { readFile, writeFile, rename, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail, boundedString } from './errors.mjs';
import { deriveProject, event } from './domain.mjs';

export const PROJECT_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export async function atomicWrite(path,data){
  const temporary=path+`.${randomUUID()}.tmp`;
  try{await writeFile(temporary,data,{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await rm(temporary,{force:true}).catch(()=>{});}
}
function idValid(id){if(!PROJECT_ID.test(id))fail(400,'invalid_id','项目或文档 ID 无效。');return id;}
export class ProjectStore{
  constructor(dataDir){this.dataDir=resolve(dataDir);this.projectsDir=join(this.dataDir,'projects');this.locks=new Map();}
  async init(){await mkdir(this.projectsDir,{recursive:true,mode:0o700});}
  path(id){return join(this.projectsDir,idValid(id));}
  async lock(id,operation){
    const before=this.locks.get(id)||Promise.resolve();let release;
    const gate=new Promise(done=>{release=done;});const pending=before.catch(()=>{}).then(()=>gate);this.locks.set(id,pending);
    await before.catch(()=>{});
    try{return await operation();}finally{release();if(this.locks.get(id)===pending)this.locks.delete(id);}
  }
  async list(){
    const dirs=await readdir(this.projectsDir,{withFileTypes:true});const list=[];
    for(const dir of dirs){if(!dir.isDirectory()||!PROJECT_ID.test(dir.name))continue;try{const project=JSON.parse(await readFile(join(this.projectsDir,dir.name,'project.json'),'utf8'));if(project.id!==dir.name)continue;list.push({id:project.id,name:project.name,revision:project.revision,document_count:project.documents.length,finding_count:project.findings.length,updated_at:project.updated_at});}catch{}}
    return list.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  async create(name,actor){
    name=boundedString(name,'项目名称',{max:120});
    const id=randomUUID(),time=new Date().toISOString();const project={id,name,revision:1,created_at:time,updated_at:time,documents:[],findings:[],events:[]};
    const directory=this.path(id);await mkdir(join(directory,'sources'),{recursive:true,mode:0o700});
    event(project,actor,'create_project','创建本地复核项目。');await atomicWrite(join(directory,'project.json'),JSON.stringify(project,null,2)+'\n');return deriveProject(project);
  }
  async readRaw(id){
    try{const project=JSON.parse(await readFile(join(this.path(id),'project.json'),'utf8'));if(project.id!==id||!Array.isArray(project.documents)||!Array.isArray(project.findings))fail(500,'project_corrupt','项目存储结构损坏，未覆盖原文件。');return project;}
    catch(error){if(error.code==='ENOENT')fail(404,'project_not_found','项目不存在。');if(error instanceof SyntaxError)fail(500,'project_corrupt','项目存储内容损坏，未覆盖原文件。');throw error;}
  }
  async hydrate(project){
    const result=structuredClone(project);
    for(const doc of result.documents){
      try{
        const path=this.documentPath(result.id,doc);const info=await stat(path);if(!info.isFile()||info.size>20*1024*1024)throw Error();
        const hash=createHash('sha256').update(await readFile(path)).digest('hex');
        doc.integrity={state:hash===doc.sha256?'pass':'fail',reason:hash===doc.sha256?'原始文件字节与导入时 SHA-256 一致。':'原始文件已变化，与导入哈希不一致；所有相关确认不能导出。'};
      }catch{doc.integrity={state:'fail',reason:'原始文件不可读取；请恢复来源后重新核对。'};}
    }
    return result;
  }
  async get(id){return this.lock(id,async()=>deriveProject(await this.hydrate(await this.readRaw(id))));}
  documentPath(projectId,document){
    if(!['pdf','txt','csv'].includes(document.type))fail(500,'invalid_stored_document','文档存储类型无效。');
    return join(this.path(projectId),'sources',`${idValid(document.id)}.${document.type}`);
  }
  async source(id,docid){return this.lock(id,async()=>{
    const project=await this.readRaw(id);const document=project.documents.find(d=>d.id===idValid(docid));if(!document)fail(404,'document_not_found','文档不存在。');
    let bytes;try{bytes=await readFile(this.documentPath(id,document));}catch(error){if(error.code==='ENOENT')fail(404,'source_missing','原始文件不可读取。');throw error;}
    if(createHash('sha256').update(bytes).digest('hex')!==document.sha256)fail(409,'source_changed','原始文件与导入哈希不一致，拒绝作为已核来源提供。');return {document,bytes};
  });}
  async mutate(id,expectedRevision,operation,{noRevision=false}={}){
    return this.lock(id,async()=>{
      const project=await this.hydrate(await this.readRaw(id));
      if(!noRevision&&(!Number.isSafeInteger(expectedRevision)||expectedRevision!==project.revision))fail(409,'stale_revision','项目已变化，请重新读取最新版本后再操作。');
      await operation(project);
      project.revision+=1;project.updated_at=new Date().toISOString();
      const stored=structuredClone(project);stored.documents.forEach(doc=>delete doc.integrity);
      // Derived checks are only response data; never persist a submitted or computed eligibility flag.
      stored.findings.forEach(f=>{delete f.checks;delete f.calculation;delete f.eligible;});
      // A derivation failure must leave the previously readable project intact.
      const result=deriveProject(await this.hydrate(stored));
      await atomicWrite(join(this.path(id),'project.json'),JSON.stringify(stored,null,2)+'\n');
      return result;
    });
  }
  async addDocument(id,parsed,actor){
    return this.mutate(id,null,async project=>{
      if(project.documents.length>=20)fail(413,'document_limit','每个项目最多导入 20 个文档，请新建项目分批复核。');
      const existing=project.documents.find(doc=>doc.sha256===parsed.document.sha256&&doc.type===parsed.document.type);
      if(existing){event(project,actor,'document_duplicate',`文件内容与“${existing.name}”相同，复用已有文档。`);return;}
      await atomicWrite(this.documentPath(id,parsed.document),parsed.bytes);
      project.documents.push(parsed.document);event(project,actor,'import_document',`导入 ${parsed.document.name}（${parsed.document.page_count} 页）。`);
    },{noRevision:true});
  }
  async delete(id,expectedRevision,actor){
    if(actor!=='browser')fail(403,'human_delete_only','删除项目须在浏览器中由用户明确操作。');
    return this.lock(id,async()=>{
      const project=await this.readRaw(id);if(!Number.isSafeInteger(expectedRevision)||project.revision!==expectedRevision)fail(409,'stale_revision','项目已变化，请刷新后确认删除。');
      const target=resolve(this.path(id)),boundary=resolve(this.projectsDir)+sep;
      if(!target.startsWith(boundary)||target===resolve(this.projectsDir))fail(400,'unsafe_path','拒绝越界删除。');
      // Rename first: deletion becomes atomic from the API's point of view.
      const retired=join(this.projectsDir,`.deleted-${id}-${randomUUID()}`);
      await rename(target,retired);await rm(retired,{recursive:true,force:true});return {deleted:true};
    });
  }
}
