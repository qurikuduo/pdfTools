# LLM Wiki

A personal knowledge base maintained by Claude Code.
Based on Andrej Karpathy's LLM Wiki pattern.

---

# Core Principles

This environment is fully offline and immutable.

Never attempt to install, update, or download anything.

Use only preinstalled local tools and existing system capabilities.

The wiki is maintained collaboratively:
- The human curates and adds source documents
- Claude organizes, summarizes, links, and maintains the knowledge structure

---

# Purpose

This wiki is a structured, interlinked knowledge base for multiple domains.

Claude maintains the wiki.
The human curates sources, asks questions, and guides analysis.

The goal is long-term knowledge compounding:
- reusable notes
- linked concepts
- evolving understanding
- searchable institutional memory

---

# Folder Structure

```text
raw/                             -- immutable source documents (never modify)
staging/                         -- intermediate extracted files (temporary workspace; do not reference in wiki)
raw_extracted/                   -- permanent parsed output: referenced by wiki pages
  {filename}.md                  -- merged Markdown for the document
  {filename}_result/images/      -- extracted images for the document
wiki/                            -- curated markdown knowledge pages
wiki/index.md                    -- table of contents for the entire wiki
wiki/log.md                      -- append-only operation log
```

---

# Tool Configuration

PDF parsing is handled by the MinerU API client tool.

```text
Tool path:  ./mineru-client.js
API URL:    http://192.168.137.135:8000
Runtime:    Node.js (node)
```

To parse a single file or all supported files from `raw/` into `staging/`:
```bash
# Single file (PDF, DOCX, DOC, PPTX, PPT)
node ./mineru-client.js raw/myfile.pdf staging

# Entire directory
node ./mineru-client.js raw staging
```

Environment variables (optional overrides):
```text
MINERU_API_URL     -- API base URL     (default: http://192.168.137.135:8000)
MINERU_CHUNK_SIZE  -- Pages per chunk  (default: 5)
MINERU_LANG        -- Language codes   (default: ch,en)
MINERU_MAX_CHUNKS  -- Limit chunks     (default: 200)
```

Output produced inside `staging/`:
```text
{pdfname}.md                     -- Final merged Markdown (use this for wiki synthesis)
{pdfname}_result/images/         -- Extracted images
pdfjobs/{pdfname}.json           -- Checkpoint (enables resume on failure)
```

The tool is idempotent — re-running it resumes from the checkpoint automatically.

---

# Offline Environment Rules

This environment is fully offline.

NEVER attempt to:

- access the internet
- install packages
- update dependencies
- use pip install
- use uv pip install
- use poetry install
- use npm install
- use npx for downloading packages
- use playwright install
- use winget
- use choco
- use curl
- use wget
- use Invoke-WebRequest
- use git clone

Assume all required tools are already preinstalled.

If a required capability is unavailable:
- report the limitation
- stop safely
- ask the user for guidance if necessary

Do NOT attempt automatic recovery through installation or downloads.

---

# Environment Safety Rules

Do not modify:

- system PATH
- npm config
- Python environments
- PowerShell profiles
- shell startup scripts
- Claude configuration files
- system registry
- firewall settings

Assume the environment is externally managed and locked down.

---

# Document Processing Rules

Document parsing uses the MinerU API client (`mineru-client.js`). Do NOT use Playwright.

Supported file types: **PDF, DOCX, DOC, PPTX, PPT** (MinerU handles all natively).

To extract a single file:
```bash
node ./mineru-client.js raw/myfile.pdf staging
```

To extract all files in a directory:
```bash
node ./mineru-client.js raw staging
```

This will:
- Submit the file(s) to the MinerU API as async tasks
- Poll for completion automatically
- Save merged Markdown to `staging/{filename}.md`
- Extract images to `staging/{filename}_result/images/`
- Save checkpoint to `staging/pdfjobs/{filename}.json` (enables resume)

After completion, read `staging/{filename}.md` for wiki synthesis.

DO NOT:
- use Playwright for document reading
- install Python PDF/Office libraries
- install OCR packages
- load raw document binary files directly into context

If the MinerU API is unreachable:
- report the limitation
- do not attempt to parse the document another way
- ask the user to verify the MinerU service is running at http://192.168.137.135:8000

---

# MinerU Error Handling

## 判断工具是否出错

运行 `node ./mineru-client.js ...` 后，通过以下方式判断是否出错：

1. **退出码非零**（exit code ≠ 0）：命令失败
2. **输出中包含 `ERROR` 关键字**：说明出错
3. **输出中包含以下字样**：
   - `aborted at chunk`
   - `Task not found`
   - `Health check failed`
   - `Server did not recover`
   - `timed out`
4. **`staging/{filename}.md` 未生成**：说明合并未完成
5. **断点文件中存在 `"status": "failed"` 的 chunk**：说明某个分块失败

成功的标志：输出末尾出现 `✓`，且 `staging/{filename}.md` 文件存在。

## 出错后的处理原则

工具内部已内置自动重试（最多 20 次，含服务器重启等待）。  
**如果工具仍然以非零退出码终止，说明自动恢复已失败，此时 Claude 应当立即停止，不要再次运行工具。**

请按以下步骤告知用户：

1. 说明是哪个文件、哪个 chunk 出错（从终端输出中读取）
2. 提示用户检查 MinerU 服务健康状态：
   ```bash
   # 在浏览器或终端中访问：
   curl http://192.168.137.135:8000/health
   # 或者直接在浏览器打开：
   # http://192.168.137.135:8000/health
   ```
   正常返回示例：
   ```json
   {"status":"healthy","version":"3.2.1", ...}
   ```
   若返回错误或无响应，说明 MinerU（Docker 容器）尚未恢复。
3. 提示用户等待 MinerU 服务恢复后，**无需任何额外操作**，直接重新运行原命令即可（断点续传会自动跳过已完成的部分）：
   ```bash
   node ./mineru-client.js raw/{filename} staging
   ```

## 不应做的事

- **不要**在工具报错后立即自动重试（会浪费时间且无意义）
- **不要**尝试绕过 MinerU 用其他方式解析文件
- **不要**删除断点文件（`staging/pdfjobs/{filename}.json`）——删除后将从头重新处理

---

# Preferred Extraction Workflow

Preferred workflow:

```text
raw/{name}.pdf / .docx / .pptx
  -> node ./mineru-client.js raw/{name}.ext staging     (1. extract to staging)
  -> copy staging/{name}.md + images → raw_extracted/   (2. promote to permanent store)
  -> read raw_extracted/{name}.md                       (3. for wiki synthesis)
  -> wiki/{topic}.md                                    (4. create/update wiki pages)
  -> integrity check                                    (5. links, images, tables, formulas)
```

Do not directly synthesize large PDFs into final wiki pages in a single step.

Never read from `staging/{name}_result/markdowns/` — use only the merged `staging/{name}.md` (or its copy at `raw_extracted/{name}.md`).

---

# Post-Extraction Copy Rules

`{name}` throughout = **file stem without extension** (e.g. `multestnew` for `multestnew.pdf`, `报告` for `报告.docx`).

After `node ./mineru-client.js ...` completes successfully (exit code 0, output ends with `✓`), follow these **4 steps in order**.

> ⚠️ **NEVER chain copy and delete in a single PowerShell command.** If the copy fails, the delete will still execute and all staging data will be permanently lost.

**Step 1 — Create destination directories:**
```bash
mkdir -p "raw_extracted/{name}_result/images"
```

**Step 2 — Copy files:**
```bash
cp -f "staging/{name}.md" "raw_extracted/{name}.md"
cp -rf "staging/{name}_result/images/"* "raw_extracted/{name}_result/images/"
```

**Step 3 — Verify the copy succeeded** before touching staging:
```bash
test -f "raw_extracted/{name}.md" && echo "md OK" || echo "md MISSING"
ls "raw_extracted/{name}_result/images/" 2>/dev/null | wc -l   # must be >= 0
```
If `md MISSING` appears, **stop immediately** — do not delete staging. Fix the path and re-run Steps 1–2.

**Step 4 — Delete the staging output** (only after Step 3 confirms success):
```bash
rm -rf "staging/{name}_result"
rm -f "staging/{name}.md"
```
> **Why:** Obsidian's Graph View indexes all `.md` files in the vault, including the per-chunk files inside `staging/{name}_result/markdowns/`. Leaving them in place creates dozens of orphan nodes with no wiki connections. Deleting the staging output keeps the graph clean.
> The checkpoint file `staging/pdfjobs/{name}.json` should be **kept** — it enables resume if reprocessing is ever needed.

After copying, `raw_extracted/` will contain:

```text
raw_extracted/{name}.md                   -- use this for wiki synthesis (NOT staging/)
raw_extracted/{name}_result/images/       -- images referenced by wiki pages
```

**Rules for wiki pages referencing this content:**
- Images must use Obsidian vault-relative path: `![[raw_extracted/{name}_result/images/{img}]]`
- Sources must link to: `[[raw_extracted/{name}|{name}.ext]]`
- Never reference `staging/` paths in any wiki page

**Recovery: checkpoint says complete but `raw_extracted/{name}.md` is missing:**

This means staging was deleted before the copy succeeded. Delete the checkpoint and re-extract:
```bash
rm -f "staging/pdfjobs/{name}.json"
node ./mineru-client.js "raw/{name}.ext" staging
```
Then repeat Steps 1–4 above.

---

# Wiki Integrity Check

After creating or modifying **any** wiki page, perform a full integrity check:

1. **Wiki-links**: Every `[[link]]` must resolve to an existing file in the vault
2. **Image paths**: Every image must use `![[raw_extracted/{name}_result/images/{img}]]` format; verify the file exists
3. **Image completeness**: Compare images in `raw_extracted/{name}_result/images/` against images referenced in the wiki page — no significant image should be missing
4. **Formula verbatim**: Compare `$...$` and `$$...$$` blocks in the wiki page against the source in `raw_extracted/{name}.md` — formula syntax must not have been altered
5. **Table completeness**: Every table present in the source section must appear in the wiki page
6. **Sources links**: Each entry in `**Sources**:` must use `[[raw_extracted/{name}|display name]]` format
7. **Tables**: All `|` separators are balanced; no broken rows
8. **Code blocks**: Opening and closing fences match (triple-backtick count is even)
9. **Formulas**: KaTeX `$...$` or `$$...$$` blocks are properly closed
10. **Headings**: No skipped levels (e.g. H1 → H3 without H2)

Fix all issues found before marking the task complete.

---

# Large Document Rules

Do not load large PDFs entirely into context at once.

Instead:
- process incrementally
- read page-by-page or section-by-section
- summarize intermediate results
- only keep relevant information in active context

Avoid excessive token usage and context overflow.

For very large documents:
- prioritize headings
- prioritize abstracts and summaries
- prioritize conclusions
- prioritize repeated concepts

---

# Context Budget Rules

This environment has a limited context window (~32K tokens). Conserve aggressively.

Rules:
- Never load a full staging Markdown file if it is larger than 50 KB
- Read staging files in sections of **at most 100 lines** at a time; use headings as split points
- **After reading each section, immediately write the wiki page(s) for that section before reading further** — do NOT read the entire document first and then start writing
- Summarize each section before moving to the next; discard raw text after summarizing
- Never hold more than one staging file section in context at a time
- When writing wiki pages, write one page at a time; **after each Write, verify with `ls wiki/{filename}.md` that the file was created before proceeding to the next page**
- Check file size before reading:
  ```bash
  wc -c "raw_extracted/{filename}.md"
  ```

If a staging file exceeds 200 KB, process only the most relevant sections:
- Prioritize headings, abstracts, conclusions
- Skip repetitive tables or appendices
- Note in `wiki/log.md` that the document was partially processed due to context limits

---

# Update Wiki Command

When the user says "I updated a document", "我更新了文档", "请更新 wiki", or equivalent:

1. List `raw/` to find supported files (PDF, DOCX, DOC, PPTX, PPT)
2. For each file, check `staging/pdfjobs/{filename}.json` — if `mergeComplete` is `true`, skip extraction
3. **Process one file at a time** (do NOT run extraction in the background or in parallel):
   ```bash
   # Always quote paths — filenames may contain Chinese characters, parentheses, or spaces
   node ./mineru-client.js "raw/{filename}" staging
   ```
4. Wait for the command to finish (may take several minutes per file)
5. For each newly extracted file, follow the **Post-Extraction Copy Rules** (Steps 1–4 above)
6. Read `raw_extracted/{name}.md` in sections of at most 100 lines (respect Context Budget Rules)
7. **For each section read: write the wiki page immediately, verify with `ls wiki/{filename}.md`, then read the next section** — do NOT read the entire document first; do NOT create multiple wiki files in the same tool call or in parallel
8. Update `wiki/index.md`
9. Append to `wiki/log.md`
10. Run integrity check on all modified wiki pages (see Wiki Integrity Check)

To check if a file is already processed:
```bash
cat "staging/pdfjobs/{filename}.json"
```
If `mergeComplete` is `true`, skip to step 5.

---

# Ingest Workflow

When the user adds a new source to `raw/` and asks you to ingest it:

1. Detect newly added files in `raw/` (PDF, DOCX, DOC, PPTX, PPT)
2. Check `staging/pdfjobs/{filename}.json` — skip extraction if `mergeComplete` is `true`
3. If not yet extracted, run (**do NOT run in the background**):
   ```bash
   # Always quote paths — filenames may contain Chinese characters, parentheses, or spaces
   node ./mineru-client.js "raw/{filename}" staging
   ```
4. Follow the **Post-Extraction Copy Rules** (Steps 1–4) to copy to `raw_extracted/` and clean staging
5. Read `raw_extracted/{name}.md` in sections of at most 100 lines (respect Context Budget Rules)
6. **For each section read: identify the major concept(s), write the wiki page(s) immediately, then verify with `ls wiki/{filename}.md` before reading the next section** — do NOT read the entire document first
7. Create wiki-links between related concepts
8. Update `wiki/index.md`
9. Append changes to `wiki/log.md`
10. Run integrity check on all created/modified wiki pages (see Wiki Integrity Check)

Minor and standard ingestion tasks may proceed automatically.

Ask the user before:
- major restructures
- deleting pages
- renaming many pages
- changing taxonomy significantly

A single source may affect many wiki pages.
This is expected and encouraged.

---

# Obsidian Rules

All generated markdown must be Obsidian-compatible.

Requirements:
- use `[[wiki-links]]`
- use relative markdown paths
- preserve readable Chinese filenames
- avoid unsupported markdown extensions
- prefer atomic notes over extremely large pages
- keep markdown human-readable
- make sure tables、formulas and images in  `raw_extracted/{name}.md` files will be referenced in wiki you generated, because this parts are usually important for knowledge base

**Content inclusion rules (mandatory):**
- **Images**: every significant image from `raw_extracted/{name}.md` MUST appear in the wiki page using Obsidian vault-relative path: `![[raw_extracted/{name}_result/images/{img}]]`. Do NOT omit images.
- **Formulas**: copy all `$...$` and `$$...$$` blocks **verbatim** from `raw_extracted/{name}.md` — do NOT rewrite, reformat, or simplify them. MinerU's output is already in the correct Obsidian/KaTeX format.
- **Tables**: include all tables from the source. Copy markdown table syntax exactly; do not summarize tables into prose.
- Images, formulas, and tables represent the most important knowledge in technical documents — omitting them is not acceptable.

When useful:
- generate tags
- generate aliases
- connect new pages to existing concepts
- avoid orphan pages
- maintain bidirectional knowledge structure

---

# Page Format

Every wiki page should follow this structure:

```markdown
# Page Title

**Summary**: One to two sentences describing this page.

**Sources**:
- [[raw_extracted/filename|filename.pdf]]
- [[raw_extracted/another-source|another-source.pdf]]

**Last updated**: YYYY-MM-DD

---

Main content goes here.

Use:
- clear headings
- short paragraphs
- bullet points where useful

Connect related concepts using [[wiki-links]] throughout the text.

## Related pages

- [[related-concept-1]]
- [[related-concept-2]]
```

---

# Citation Rules

Every factual claim should reference its source file.

Use this format:

```text
(source: filename.pdf)
```

Rules:
- if two sources disagree, note the contradiction explicitly
- if confidence is low, say so clearly
- if a claim lacks evidence, mark it as needing verification
- avoid inventing unsupported facts

---

# Question Answering

When the user asks a question:

1. Read `wiki/index.md`
2. Identify relevant wiki pages
3. Read and synthesize relevant content
4. Cite specific wiki pages
5. State clearly when information is missing
6. Offer to save valuable new findings into the wiki

Good answers should compound back into the knowledge base over time.

---

# Lint / Audit Workflow

When the user asks to lint or audit the wiki:

Check for:
- contradictions between pages
- orphan pages
- broken wiki-links
- concepts lacking dedicated pages
- outdated claims
- formatting inconsistencies
- duplicated concepts
- oversized pages that should be split

Return findings as:
1. issue
2. impact
3. suggested fix

---

# Naming Rules

Rules:
- keep page names lowercase when possible
- use hyphens for English filenames
- preserve readable Chinese names for Chinese content
- avoid special characters
- keep names concise and meaningful

Examples:

```text
machine-learning.md
rag-architecture.md
向量数据库.md
知识图谱.md
```

---

# Link Safety Rules

After generating or modifying pages:

- verify all wiki-links
- ensure links inside tables are valid
- avoid malformed `[[links]]`
- ensure `|` characters do not break wiki-link syntax

---

# Failure Handling

If a task cannot be completed using existing local tools:

- do not install alternatives
- do not search online for solutions
- do not modify the environment

Instead:
- explain the limitation
- suggest manual intervention if needed
- preserve partial progress where possible

---

# Immutable Source Rules

Never modify files inside `raw/`.

`raw/` is the immutable source archive.

All derived content must go into:
- `staging/`       (temporary extraction workspace)
- `raw_extracted/` (permanent parsed output, referenced by wiki)
- `wiki/`          (curated knowledge pages)

---

# Operational Logging Rules

Always update:
- `wiki/index.md`
- `wiki/log.md`

after wiki changes.

`wiki/log.md` should contain:
- timestamp
- source file
- affected pages
- summary of changes

Example:

```markdown
2026-05-26
- Source: ai-paper.pdf
- Updated:
  - [[transformer]]
  - [[attention-mechanism]]
  - [[llm-scaling]]
- Added summary and cross-links
```

---

# Writing Style Rules

Write in:
- clear language
- concise language
- technically accurate language

Avoid:
- marketing language
- unnecessary verbosity
- unsupported speculation

Prefer:
- structure
- readability
- maintainability
- long-term clarity

---

# Final Goal

The final goal is a continuously evolving offline knowledge system:

```text
raw/
    source PDFs

raw_extracted/
    extracted markdown/text

wiki/
    structured linked knowledge
```

Claude should behave like:
- a careful librarian
- a technical researcher
- a structured knowledge maintainer

NOT like:
- an autonomous installer
- a dependency manager
- an internet-connected assistant
