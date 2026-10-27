# 浏览器验收记录与复验方法

本页记录本地工作台的自动化浏览器验收。测试使用独立服务进程、空数据目录和构造资料；不会读写既有用户项目。领域/API测试、浏览器测试和发布包安装是三层检查，结果分别记录，不能互相替代。

## Release gates and minimum demonstration quality

| ID | Failure mode | Minimum observable result | Block release when |
|---|---|---|---|
| B01 | Empty app misrepresents populated data | Clear empty state, usable new-project and file/Agent import entries | Demo invents an existing company or cannot start |
| B02 | Uploaded bytes lost or altered | TXT, CSV, actual selectable-text PDF imported; hashes/original download agree | Incorrect bytes or another project's file returned |
| B03 | OCR invented | Image-only PDF explicitly warns that text is unavailable | Fabricated extracted text or claimed OCR success |
| B04 | Agent output self-confirms or overwrites a newer version | API/CLI/browser import leaves pending; stale/missing browser revision cannot overwrite current work | Agent can grant confirmed status, use review endpoint, or silently override newer edits |
| B05 | Wrong page / amount substring | Wrong page and 120.00-vs-1200.00 candidate fails source check | Candidate can be confirmed/exported as fact |
| B06 | Column swap mistaken for proof | Literal quote check describes traceability; checkbox requires actual human check | Text matching is described as automatic column/period correctness or import auto-confirms |
| B07 | Unknown or invalid comparison | Null, zero/negative base, incompatible periods/currency/entity/scope explained | Missing becomes zero, invalid ordinary percent, hidden comparison issue |
| B08 | Correction leaves stale result | Edit valid input, exact recompute, old confirmation cleared, version/event retained | Old confirmation remains exportable or original imported copy lost |
| B09 | Restore resurrects approval | Restore original inputs but require new confirmation | Previous confirmation becomes valid automatically |
| B10 | Human review bypass | Confirm requires explicit checkbox; rejected can be reopened | Programmatic review without attestation succeeds or UI silently checks it |
| B11 | Export ambiguity | JSON/Markdown separate facts and pending; CSV fact rows only; amounts remain strings | Pending/blocked/rejected/stale facts leak or CSV formulas execute |
| B12 | Work disappears on restart | Same persisted project/revision, edits/events/confirmation after server stop/start | State or source bytes lost, or revoked confirmation resurrected |
| B13 | Outer page scroll / unusable small viewport | 1280×720, 1440×900, 390×844: app fits; work scrolls inside panels/tabs | Horizontal overflow, outer body scroll during work, inaccessible confirm/export |
| B14 | XSS in inputs/documents | Payloads visible as text; no handler execution or unexpected element | Any injected script/event executes |
| B15 | Private files / token boundary | Unauthenticated source/export denied; source directories not static | Private workspace or agent/browser token separation exposed |
| B16 | Distribution/claim mismatch | Documented commands actually work in clean data dir; no API key or remote service needed | Bundle depends on personal-site files or claims unsupported LLM/MCP/user-results |

## Fixture policy

Use `tests/fixtures/qa-financials.txt`, `.csv`, `.pdf` and their templates. All figures are synthetic. Current/prior periods are 2026 H1 and 2025 H1 within one document. Independent arithmetic reference: revenue 120.00/100.00 gives 20.00%; operating cash flow 60.00/80.00 gives -25.00%. Expected values do not count as executed outcomes.

公开财报另作资料解析和 CLI 连通性抽查，记录见 [VALIDATION.md](VALIDATION.md)。该抽查与这里的构造用例分开，不作为模型抽取准确率的证据。

## 自动化复验

准备 Node.js 24+、Python 3.10+ 与 Python Playwright，先在仓库根目录安装依赖：

```sh
npm ci --ignore-scripts
python -m pip install playwright==1.60.0
python -m playwright install chromium
python -X utf8 tests/browser_run.py --out ./test-results/browser-acceptance-v0.1.0
```

每次使用新的 `--out` 目录；旧记录与测试数据会保留，脚本拒绝覆盖。默认端口 `4399`，被占用时使用 `--port 4400`。脚本自行启动测试服务，在浏览器流程完成后停止并重启同一服务，核验持久化数据和原文件哈希；不停止其他运行中的工作台。

输出包括 `browser-flow-results.json`、`browser-restart-results.json`、原文件与导出文件、各视口截图，以及仅供复验的 `runtime/`。该目录包含本地运行凭据，不能提交或打包公开；`.gitignore` 已排除 `test-results/`。

## 检查顺序

1. Start server on an isolated test port and isolated `FILINGS_DATA_DIR`. Read bootstrap and discover rendered accessible selectors before interactions.
2. Create project; import new TXT/CSV/PDF bytes; use documented CLI or bearer API to import candidate JSON; inspect pending state.
3. Run source/page/amount/null/column/review-injection checks. Inspect the real UI copy before declaring B06 pass.
4. Through browser: select source, edit, confirm with checkbox, edit and verify invalidation, restore/reopen/reject, confirm again, download and parse all formats.
5. Run desktop/mobile viewport and inner-scroll checks plus XSS sentinel.
6. Persist checkpoint; stop and restart the same isolated data directory; validate data/source hashes, events and approval validity. Never stop another task's server.
7. Audit README/package/distribution against observed behavior. Record command, environment, timestamp, screenshots, actual observations and limitations.

## 执行结果

2026-10-28，在 Windows、Node.js 24.16.0、Python 3.10.8、Playwright 1.60.0 Chromium 上完成最终复验：**浏览器流程 9/9 分组通过，实际进程重启恢复 1/1 通过，共 10 个执行分组，0 失败、0 浏览器运行错误**。本次数量按脚本执行分组计数，不等于 10 个独立风险，也不将其中 15 条候选重复算作 15 次模型成功。

已执行的流程包含：

- 从空界面建立项目，实际上传 UTF-8 TXT、CSV、3 页可选中文字 PDF；返回原文件与输入字节、SHA-256 一致，浏览器“原文件”按钮下载的 PDF 字节也一致。
- 通过配套 CLI 读取服务解析的页文本，导入 15 个候选；全部初始为待复核，点击“刷新项目数据”后出现在浏览器。
- 错页、金额子串、缺失数值、跨文件、错期间、币种不一致和缺口径均被阻断；零/负数基期不显示普通增长率。扫描 PDF 显示警告，不生成虚构文本。
- 倒置本期/上期列不会被文本匹配自动识别。实际检查了界面的解释及人工勾选要求；未勾选不能确认。这里证明的是明确的人审流程，不是机器理解了财报列含义。
- 浏览器确认后修改数值 `120.00 → 130.00`，计算 `20.00% → 30.00%`，旧确认失效；恢复初始候选仍需重审，驳回、重新打开、再次确认均可完成。
- 浏览器通过 JSON 文件导入候选时保留文件的 `expected_revision`。过期版本返回 `409 stale_revision`；缺版本显示明确错误。两种拒绝前后项目内容完全一致。最新版本导入仍是待复核。
- JSON、CSV、Markdown 均实际下载并解析；只有 2 条有效确认进入事实，未确认事项不进入 CSV，公式形状的标签经过转义；CLI 导出另存成功。
- 1280×720、1440×900、390×844 三种视口无横向溢出，工作台边界留在视口内，鼠标滚轮在事项区滚动而外页不动；手机布局可重新确认并下载 JSON。
- 文档和候选中的 XSS 字符串没有执行；无浏览器 `pageerror`。实际停止并重启服务后，项目、版本、事件、确认状态和原文件哈希保持一致。

B01–B14 由此浏览器套件覆盖。B15 的服务访问边界由 `npm test` 单独核验；B16 的干净下载包安装由发布验收单独记录。完整发布结果见 [VALIDATION.md](VALIDATION.md)。

以上是自动化验收与截图复查，没有真实模型调用、目标用户研究或财务抽取准确率实验。Agent 候选由测试夹具提供；“已确认”表示该本地浏览器流程已被执行，不代表可信签名或不可伪造的人工身份。
