import { writeFile } from 'node:fs/promises';
const company = '北辰研究用品有限公司（构造样例）';
const rows = [
  ['营业收入','revenue','1200000.00','1000000.00'],
  ['归母净利润','net_profit','180000.00','150000.00'],
  ['经营活动现金流量净额','operating_cash_flow','90000.00','120000.00'],
];
const lines = rows.map(([label,,current,prior]) => `${label}：2025年度 ${current} 元；2024年度 ${prior} 元。`);
const text = `${company}\n2025年度财务摘要（纯构造数据，仅用于体验与软件测试）\n主体：${company}\n范围：合并报表；币种：人民币CNY；单位：元。\n报告期间：2025年1月1日—2025年12月31日；上年同期：2024年1月1日—2024年12月31日。\n本表列示相同会计口径的本期及上年同期数值。\n${lines.join('\n')}\n说明：本文不对应任何真实企业，也不构成真实研究结论。\n`;
const input = (year, value, quote) => ({document_id:'__DOCUMENT__',page:1,quote,value,unit:'元',currency:'CNY',entity:company,scope:'合并报表',period_start:`${year}-01-01`,period_end:`${year}-12-31`,period_type:'flow'});
const findings = rows.map(([label,metric,current,prior],i) => ({label,metric,current:input(2025,current,lines[i]),prior:input(2024,prior,lines[i])}));
const sample = {name:'构造样例 · 两期指标复核',document:{name:'构造样例-2025财务摘要.txt',text},findings};
await writeFile(new URL('../samples/sample-data.json',import.meta.url), JSON.stringify(sample,null,2)+'\n');
await writeFile(new URL('../web/sample-data.json',import.meta.url), JSON.stringify(sample,null,2)+'\n');
await writeFile(new URL('../samples/sample.txt',import.meta.url),text);
await writeFile(new URL('../samples/candidates.template.json',import.meta.url),JSON.stringify({schema_version:'1.0',expected_revision:0,findings},null,2)+'\n');
