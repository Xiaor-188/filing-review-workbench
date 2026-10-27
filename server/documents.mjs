import { createHash, randomUUID } from 'node:crypto';
import { fail, exactFields, boundedString } from './errors.mjs';

export const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 2_000_000;
export async function parseDocument(payload) {
  exactFields(payload,['name','content_base64'],['name','content_base64']);
  const name=boundedString(payload.name,'文件名',{max:160});
  if(/[\\/:\x00-\x1f]/.test(name)||name==='.'||name==='..'||name.endsWith('.'))fail(400,'invalid_filename','文件名不能含路径、控制字符或末尾句点。');
  const match=/\.([^.]+)$/.exec(name);const type=match?.[1].toLowerCase();
  if(!['pdf','txt','csv'].includes(type))fail(400,'unsupported_file','只支持 PDF、UTF-8 TXT 与 UTF-8 CSV。');
  const encoded=payload.content_base64;
  if(typeof encoded!=='string'||encoded.length>Math.ceil(MAX_BYTES/3)*4+4)fail(413,'file_too_large','单个文件不能超过 20 MB。');
  if(!encoded || encoded.length%4!==0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))fail(400,'invalid_base64','文件内容不是严格 Base64 编码。');
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>MAX_BYTES)fail(413,'file_too_large','文件为空或超过 20 MB。');
  if(bytes.toString('base64')!==encoded)fail(400,'invalid_base64','文件编码不能完整还原。');
  const warnings=[];let pages;
  if(type==='pdf'){
    if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')fail(400,'invalid_pdf_signature','扩展名为 PDF，但文件头不符合 PDF 格式。');
    let task,pdf;
    try{
      const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
      task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:false,verbosity:0,stopAtErrors:true});
      pdf=await task.promise;
      if(pdf.numPages>100)fail(413,'page_limit','首版每个 PDF 最多 100 页。');
      pages=[];let total=0;
      for(let number=1;number<=pdf.numPages;number++){
        const page=await pdf.getPage(number);const content=await page.getTextContent();
        const items=content.items.filter(item=>typeof item.str==='string');
        let text='',lastY=null;
        for(const item of items){const y=item.transform?.[5];if(lastY!==null&&y!==undefined&&Math.abs(y-lastY)>3&&!text.endsWith('\n'))text+='\n';text+=item.str+(item.hasEOL?'\n':' ');lastY=y;}
        text=text.replace(/[ \t]+\n/g,'\n').trim();total+=text.length;
        if(total>MAX_TEXT)fail(413,'text_limit','提取文本超过 200 万字符，请拆分报告后导入。');
        if(!text)warnings.push(`第 ${number} 页未提取到文本，可能是扫描或空白页；本版不做 OCR。`);
        pages.push({number,text});page.cleanup();
      }
    }catch(error){
      if(error.status)throw error;
      if(error.name==='PasswordException')fail(400,'encrypted_pdf','此 PDF 需要密码，请先提供可直接读取的副本。');
      fail(400,'pdf_parse_failed','PDF 解析失败。请检查文件是否损坏，或改用 UTF-8 文本。');
    }finally{try{await pdf?.destroy();if(!pdf)await task?.destroy();}catch{}}
  }else{
    if(bytes.subarray(0,5).toString('ascii')==='%PDF-')fail(400,'file_signature_mismatch','文件内容为 PDF，请使用真实的 .pdf 扩展名。');
    let text;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail(400,'invalid_utf8','TXT/CSV 必须为 UTF-8 编码，请转换后再导入。');}
    text=text.replace(/^\uFEFF/,'');
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))fail(400,'binary_text','文件含二进制控制字符，不是可导入的纯文本。');
    if(text.length>MAX_TEXT)fail(413,'text_limit','文本超过 200 万字符，请拆分文件。');
    if(!text.trim())warnings.push('此文件没有非空文本，无法为候选提供证据。');
    pages=[{number:1,text}];
  }
  return {document:{id:randomUUID(),name,type,sha256:createHash('sha256').update(bytes).digest('hex'),page_count:pages.length,pages,warnings},bytes};
}
