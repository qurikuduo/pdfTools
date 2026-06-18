# pdfTools — MinerU 文档解析客户端

一个自包含的 Node.js 命令行工具，通过本地局域网部署的 [MinerU](https://github.com/opendatalab/MinerU) API 服务器，将 **PDF、DOCX、DOC、PPTX、PPT** 文件解析为 Obsidian 兼容的 Markdown。支持单文件和批量目录两种模式。无需任何 npm 依赖。

---

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [命令行用法](#命令行用法)
- [配置参数](#配置参数)
- [输出目录结构](#输出目录结构)
- [断点续传](#断点续传)
- [多语言支持](#多语言支持)
- [LLM Wiki 集成](#llm-wiki-集成)
- [常见问题排查](#常见问题排查)

---

## 环境要求

| 要求 | 说明 |
|---|---|
| **Node.js** v16 及以上 | 仅使用内置模块：`http`、`https`、`fs`、`path`、`crypto`、`zlib` |
| **MinerU API 服务器** | 必须在局域网内运行并可访问。默认地址：`http://192.168.137.135:8000` |

无需执行 `npm install`，脚本无任何第三方依赖。

验证 Node.js 是否可用：
```bash
node --version
```

验证 MinerU API 是否可访问：
```bash
node mineru-client.js  # 不带参数运行可查看使用说明
```

---

## 快速开始

```bash
# 解析单个文件（PDF、DOCX、PPTX 等）
node ./mineru-client.js raw/myreport.pdf staging

# 解析 raw/ 目录中所有支持的文件
node ./mineru-client.js raw staging
```

执行流程：
1. 自动检测页数；若 ≤1000 页则以**单一任务**处理全文（单 chunk 模式），超过阈值则以 50 页为单位分片
2. 轮询任务状态，遇到临时错误自动重试
3. 将每个任务的 Markdown 保存至 `staging/{stem}_result/markdowns/`
4. 提取图片至 `staging/{stem}_result/images/`
5. 将所有块合并为 `staging/{stem}.md`（Obsidian 兼容格式）
6. 将断点记录写入 `staging/pdfjobs/{filename}.json`

---

## 命令行用法

```
node mineru-client.js <input_path> <output_dir> [checkpoint_start]
```

| 参数 | 说明 |
|---|---|
| `input_path` | 单个文件（PDF/DOCX/DOC/PPTX/PPT）**或**包含此类文件的目录 |
| `output_dir` | 所有输出文件的写入目录 |
| `checkpoint_start` | *（可选，仅目录模式）* 从指定文件名开始恢复处理，字母序在其之前的文件将被跳过 |

**示例：**

```bash
# 单个文件
node mineru-client.js raw/report.pdf staging
node mineru-client.js raw/slides.pptx staging
node mineru-client.js raw/doc.docx staging

# 解析目录中所有支持的文件
node mineru-client.js raw staging

# 中断后从指定文件恢复目录批量处理
node mineru-client.js raw staging "report-b.pdf"

# 使用绝对路径
node ./mineru-client.js D:\vault\raw D:\vault\staging
```

---

## 配置参数

所有配置通过环境变量控制，无需配置文件。

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `MINERU_API_URL` | `http://192.168.137.135:8000` | MinerU API 基础地址 |
| `MINERU_CHUNK_SIZE` | `50` | 每次 API 请求处理的页数（仅在分片模式下生效） |
| `MINERU_LANG` | `ch,en` | 语言代码，逗号分隔（见下文） |
| `MINERU_BACKEND` | `hybrid-auto-engine` | MinerU 解析后端 |
| `MINERU_MAX_CHUNKS` | `200` | 每个 PDF 最大块数（上限约10000 页） |
| `MINERU_SINGLE_CHUNK_THRESHOLD` | `1000` | 页数不超过此阈值的文档以单一任务提交，避免重复上传整个文件。设为 `0` 可强制始终使用分片模式。 |
| `MINERU_POLL_TIMEOUT_MS` | `1800000` | 单个任务的超时时间（毫秒，默认 30 分钟）。处理较大文档时可适当增大。 |
| `MINERU_DEBUG` | `0` | 设为 `1` 可打印原始 API 响应 |

**Windows 下设置环境变量（PowerShell）：**

```powershell
$env:MINERU_API_URL = "http://10.0.0.5:8000"
$env:MINERU_CHUNK_SIZE = "10"
$env:MINERU_LANG = "ch,en"
node mineru-client.js raw staging
```

**行内设置（bash/cmd）：**

```bash
MINERU_LANG=en MINERU_CHUNK_SIZE=30 node mineru-client.js raw staging
```

---

## 输出目录结构

每个 PDF 在 `output_dir` 下生成以下文件：

```
output_dir/
├── {stem}.md                           ← 最终合并 Markdown（使用此文件）  ({stem} = 不含扩展名的文件名)
├── {stem}_result/
│   ├── markdowns/
│   │   ├── chunk_0000_0152.md          ← 每个任务生成一个文件（单 chunk 模式：覆盖全部页面）
│   │   └── ...                         （超过 1000 页的文档才会生成多个文件）
│   └── images/
│       ├── chunk0000_figure1.png       ← 提取的图片（带块编号前缀）
│       └── ...
└── pdfjobs/
    └── {filename}.json                 ← 断点记录文件  ({filename} = 含扩展名的完整文件名)
```

**最终合并文件 `{stem}.md` 是唯一需要用于后续处理的文件。**

合并后 Markdown 中的图片路径为 Obsidian 相对路径，格式如下：
```markdown
![图片: chunk0000_figure1.png]({stem}_result/images/chunk0000_figure1.png)
```

---

## 断点续传

本工具具有**幂等性** — 重新运行会自动从中断处恢复，不会重复处理已完成的内容。

每个文件的断点记录保存在 `output_dir/pdfjobs/{filename}.json`（含扩展名的完整文件名），记录内容包括：
- 每个块的处理状态（`pending` / `completed` / `skipped` / `failed`）
- PDF 是否已完成全部合并（`mergeComplete: true`）

**恢复行为：**
- 已完成的块直接跳过，不重复处理
- 若 `mergeComplete` 为 `true`，该 PDF 整体跳过
- 断点文件采用原子写入方式（先写 `.tmp` 再重命名），防止断电导致数据损坏

**MinerU 服务重启自动恢复：**  
若 MinerU 的 Docker 容器在处理过程中重启，工具会在任意阶段（提交任务 / 轮询状态 / 获取结果）检测到 `404 Task not found` 或连接错误，随后自动等待服务恢复（以指数退避方式轮询 `/health`，最长等待 30 分钟），服务恢复后自动重新提交任务，全程无需人工干预。

**检查某 PDF 是否已处理完成（PowerShell）：**
```powershell
$j = Get-Content "staging\pdfjobs\myfile.pdf.json" | ConvertFrom-Json
"done=$($j.chunks.Where({$_.status -eq 'completed'}).Count) mergeComplete=$($j.mergeComplete)"
```

**强制重新处理**（删除断点文件即可）：
```powershell
Remove-Item "staging\pdfjobs\myfile.pdf.json"
```

---

## 多语言支持

将 `MINERU_LANG` 设置为逗号分隔的语言代码列表：

| 代码 | 语言 |
|---|---|
| `ch` | 中文（简体） |
| `en` | 英文 |
| `ch,en` | 中英混合文档 |
| `ja` | 日文 |
| `ko` | 韩文 |

中英混合文档示例：
```powershell
$env:MINERU_LANG = "ch,en"
node mineru-client.js raw staging
```

---

## LLM Wiki 集成

本工具设计用于配合 [LLM Wiki](CLAUDE.md) 系统，由本地部署的大语言模型（如 Claude）基于 PDF 来源维护 Obsidian 知识库。

**工作流程：**

```
raw/{name}.pdf
  → node mineru-client.js raw staging
  → staging/{name}.md          （供 Wiki 综合分析使用）
  → wiki/{topic}.md            （创建或更新 Wiki 页面）
```

**触发指令** — 当你对 LLM 说"请更新 wiki"或"I updated a document"时，它将：
1. 检测 `raw/` 目录中的新 PDF 文件
2. 检查断点记录，跳过已处理的文件
3. 运行 `node ./mineru-client.js raw staging`
4. 分节读取 `staging/{name}.md`
5. 综合分析并更新 `wiki/` 中的知识页面
6. 更新 `wiki/index.md` 和 `wiki/log.md`

完整的 LLM 指令集请参阅 [CLAUDE.md](CLAUDE.md)。

---

## 常见问题排查

### API 无法访问

```
ERROR Health check failed: connect ECONNREFUSED 192.168.137.135:8000
```

- 确认 MinerU 服务器正在运行：`curl http://192.168.137.135:8000/health`
- 检查 IP 地址和端口是否正确；可通过 `MINERU_API_URL` 覆盖
- 确保运行本工具的机器与 MinerU 服务器在同一局域网内

### 任务超时

```
ERROR Task abc123 timed out after 1800s
```

- 页数 ≤1000 的文档以单任务提交；内容复杂（大量表格、公式）时可能超过默认 30 分钟超时限制
- 增大超时时间：`$env:MINERU_POLL_TIMEOUT_MS = "3600000"`（1 小时）
- 或将阈值调小以回退到分片模式：`$env:MINERU_SINGLE_CHUNK_THRESHOLD = "0"`
- 直接重新运行命令，已完成的块会自动跳过

### 输出损坏或为空

- 启用调试模式查看原始 API 响应：`MINERU_DEBUG=1`
- 客户端按顺序尝试以下字段名：`md_content`、`markdown`、`md`、`content`
- 若 `results` 结构异常，调试日志会输出顶层字段名和 item 字段名以供排查

### 合并文件中出现重复内容

合并器会自动检测并删除相邻块之间的重复行。若日志中出现 `Dedup: removed N overlapping lines`，属于正常行为。

### 对单个 PDF 强制重新处理

删除其断点文件后重新运行：
```powershell
Remove-Item "staging\pdfjobs\myfile.pdf.json"
node mineru-client.js raw staging
```
