# 本地Agent接口

先启动服务，再调用API。默认地址 `http://127.0.0.1:4318`。推荐直接用 `npm run agent -- help`，避免自行处理运行凭据。

CLI从 `.local-data/runtime.json` 读取当前端口及 Agent token，以 `Authorization: Bearer ...` 调用本机接口。token每次启动重新生成，不要复制到提示词、日志、仓库或第三方服务器。

浏览器通过 `/api/session` 取得会话cookie及CSRF token。浏览器写请求携带 `X-CSRF-Token`；Agent token不能执行人工确认或删除项目。拒绝跨Origin和非本机Host访问。

这一区分用于约束工具流程，不是对本机进程的身份认证。能够控制浏览器或读取本机文件的自动化工具仍须遵守人工确认约定；本版不提供多用户登录或可信人工签名。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/health` | 服务状态 |
| `GET /api/projects` | 项目列表 |
| `POST /api/projects` | `{name}`创建项目 |
| `GET /api/projects/:id` | 当前项目、文档页文本、候选、检查和记录 |
| `POST /api/projects/:id/documents` | `{name,content_base64}`导入文件 |
| `GET /api/projects/:id/documents/:docid/file` | 获取已导入原文件 |
| `POST /api/projects/:id/import` | 按候选schema导入；全部待人工复核 |
| `PATCH /api/projects/:id/findings/:fid` | 修改工作副本，撤销旧确认 |
| `GET /api/projects/:id/export?format=json` | 导出；format还支持csv、markdown |

浏览器专用人工操作：`POST /api/projects/:id/findings/:fid/review`，action为confirm、reject、reopen或restore；confirm必须带`attested:true`。该声明表示用户实际核对了原文与列对应，Agent不能代填。恢复原始导入值不会恢复旧确认。

导入示意：

```json
{
  "schema_version": "1.0",
  "expected_revision": 2,
  "findings": [{
    "label": "营业收入同比",
    "metric": "revenue",
    "current": {
      "document_id": "替换为已导入文档ID",
      "page": 1,
      "quote": "替换为该页逐字摘录",
      "value": "1200000.00",
      "unit": "元",
      "currency": "CNY",
      "entity": "替换为已核主体",
      "scope": "合并报表",
      "period_start": "2025-01-01",
      "period_end": "2025-12-31",
      "period_type": "flow"
    },
    "prior": {
      "document_id": "替换为同一文档ID",
      "page": 1,
      "quote": "替换为上年同期的逐字摘录",
      "value": "1000000.00",
      "unit": "元",
      "currency": "CNY",
      "entity": "替换为已核主体",
      "scope": "合并报表",
      "period_start": "2024-01-01",
      "period_end": "2024-12-31",
      "period_type": "flow"
    }
  }]
}
```

这段是结构说明，不能原样作为真实候选提交。用 `context` 返回的id、revision与页文本替换。`value`为十进制字符串或null；不带千分位和货币符号。未知日期/口径/单位用空字符串，未知页码用null，工具将保留待核。

同一finding的更新带现有id；新finding不带id。来源变化、数值变化和重新导入内容发生变化时都会撤销相关确认；同一版本内容完全相同的重复导入保留确认。导入不能设置status、checks、eligible或confirmation。

错误统一为 `{ "error": { "code": "...", "message": "..." } }`。409须按code处理：`stale_revision`表示版本冲突，先重新读取项目，不要强行覆盖；`source_changed`表示原文件已变化；`checks_blocked`表示确认条件尚未满足。413表示文件/请求超过限制。无有效确认项时CSV没有事实行，JSON/Markdown仍可展示待核项。
