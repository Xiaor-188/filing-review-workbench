import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../',import.meta.url));
const roots = ['server','web','scripts','docs','samples','tests'];
const top = ['README.md','AGENTS.md','LICENSE','package.json','package-lock.json','.gitignore','.gitattributes','.env.example','.node-version','start.sh','启动工作台.cmd'];
const paths = [];
async function walk(folder) {
  for (const entry of await readdir(path.join(root,folder),{withFileTypes:true})) {
    if (entry.name==='__pycache__') continue;
    const p = path.posix.join(folder,entry.name);
    if(entry.isSymbolicLink()) throw Error(`发布文件不能是符号链接：${p}`);
    if(entry.isDirectory()) await walk(p); else paths.push(p);
  }
}
for(const folder of roots) await walk(folder);
paths.push(...top);
const errors=[];
for(const p of paths) {
  const s=await stat(path.join(root,p));
  if(!s.isFile())errors.push(`${p}不是普通文件`);
  if(p.endsWith('.cmd') && /(?<!\r)\n/.test(await readFile(path.join(root,p),'utf8')))errors.push(`Windows 启动脚本必须使用 CRLF 换行：${p}`);
  if(/(?:^|\/)(?:\.local-data|node_modules|private|career|\.vercel)(?:\/|$)|runtime\.json$|\.env(?!\.example)/.test(p)) errors.push(`私有运行文件：${p}`);
  if(/\.(?:js|mjs|html|json|md|txt|css|py)$/.test(p)) {
    const content=await readFile(path.join(root,p),'utf8');
    if(/(?:sk-[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/.test(content))errors.push(`疑似真实凭据：${p}`);
    if(/[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+|\/(?:Users|home)\/[A-Za-z0-9_.-]+\//i.test(content))errors.push(`机器专属用户目录：${p}`);
  }
}
if(errors.length) { console.error(errors.join('\n')); process.exitCode=1; }
else console.log(`发布文件检查通过：${paths.length}个白名单文件；私有数据、依赖目录和运行凭据不在分发清单中。`);
