# pdfTools — MinerU Document Parsing Client

A self-contained Node.js CLI tool that parses **PDF, DOCX, DOC, PPTX, and PPT** files into Obsidian-compatible Markdown via a locally-hosted [MinerU](https://github.com/opendatalab/MinerU) API server. Supports single-file and batch-directory modes. No npm dependencies required.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
- [Output Layout](#output-layout)
- [Checkpoint & Resume](#checkpoint--resume)
- [Multi-language Support](#multi-language-support)
- [LLM Wiki Integration](#llm-wiki-integration)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js** v16 or later | Uses only built-in modules: `http`, `https`, `fs`, `path`, `crypto` |
| **MinerU API server** | Must be running and reachable on your LAN. Default: `http://192.168.137.135:8000` |

No `npm install` is needed. The script has zero third-party dependencies.

To verify Node.js is available:
```bash
node --version
```

To verify the MinerU API is reachable:
```bash
node mineru-client.js  # run without arguments to see usage
```

---

## Quick Start

```bash
# Parse a single file (PDF, DOCX, PPTX, ...)
node ./mineru-client.js raw/myreport.pdf staging

# Parse all supported files in the raw/ directory
node ./mineru-client.js raw staging
```

This will:
1. Submit the file(s) to the MinerU API in 5-page chunks
2. Poll for completion, retrying automatically on transient errors
3. Save per-chunk Markdown to `staging/{pdfname}_result/markdowns/`
4. Extract images to `staging/{pdfname}_result/images/`
5. Merge all chunks into `staging/{pdfname}.md` (Obsidian-compatible)
6. Write a checkpoint to `staging/pdfjobs/{pdfname}.json`

---

## CLI Usage

```
node mineru-client.js <input_path> <output_dir> [checkpoint_start]
```

| Argument | Description |
|---|---|
| `input_path` | A single file (PDF/DOCX/DOC/PPTX/PPT) **or** a directory containing such files |
| `output_dir` | Directory where all output files will be written |
| `checkpoint_start` | *(Optional, directory mode only)* Filename to resume from. Files alphabetically before this are skipped |

**Examples:**

```bash
# Single file
node mineru-client.js raw/report.pdf staging
node mineru-client.js raw/slides.pptx staging
node mineru-client.js raw/doc.docx staging

# All supported files in a directory
node mineru-client.js raw staging

# Resume directory batch from a specific file after an interruption
node mineru-client.js raw staging "report-b.pdf"

# Use absolute paths
node ./mineru-client.js D:\vault\raw D:\vault\staging
```

---

## Configuration

All settings are controlled via environment variables. No config file is needed.

| Variable | Default | Description |
|---|---|---|
| `MINERU_API_URL` | `http://192.168.137.135:8000` | MinerU API base URL |
| `MINERU_CHUNK_SIZE` | `5` | Pages per API request |
| `MINERU_LANG` | `ch,en` | Language codes, comma-separated (see below) |
| `MINERU_BACKEND` | `hybrid-auto-engine` | MinerU parsing backend |
| `MINERU_MAX_CHUNKS` | `200` | Maximum chunks per PDF (caps at 4000 pages) |
| `MINERU_DEBUG` | `0` | Set to `1` to print raw API responses |

**Setting variables on Windows (PowerShell):**

```powershell
$env:MINERU_API_URL = "http://10.0.0.5:8000"
$env:MINERU_CHUNK_SIZE = "10"
$env:MINERU_LANG = "ch,en"
node mineru-client.js raw staging
```

**Setting variables inline (bash/cmd):**

```bash
MINERU_LANG=en MINERU_CHUNK_SIZE=30 node mineru-client.js raw staging
```

---

## Output Layout

For each PDF, the following files are created inside `output_dir`:

```
output_dir/
├── {pdfname}.md                        ← Final merged Markdown (use this)
├── {pdfname}_result/
│   ├── markdowns/
│   │   ├── chunk_0000_0019.md          ← Per-chunk intermediate Markdown
│   │   ├── chunk_0020_0039.md
│   │   └── ...
│   └── images/
│       ├── chunk0000_figure1.png       ← Extracted images (chunk-prefixed)
│       └── ...
└── pdfjobs/
    └── {pdfname}.json                  ← Checkpoint file
```

**The final merged file `{pdfname}.md` is the only file you need for downstream use.**

Image paths in the merged Markdown are Obsidian-relative and non-breaking:
```markdown
![图片: chunk0000_figure1.png]({pdfname}_result/images/chunk0000_figure1.png)
```

---

## Checkpoint & Resume

The tool is **idempotent** — re-running it automatically resumes from where it stopped.

Each PDF gets a checkpoint at `output_dir/pdfjobs/{pdfname}.json` that tracks:
- Status of every chunk (`pending` / `completed` / `skipped` / `failed`)
- Whether the full PDF merge is complete (`mergeComplete: true`)

**Resume behavior:**
- Completed chunks are skipped — no re-processing
- If `mergeComplete` is `true`, the PDF is fully done and will be skipped entirely
- Checkpoints are saved atomically (write to `.tmp`, then rename) to prevent corruption on power loss

**MinerU server-restart resilience:**  
If the MinerU Docker container restarts mid-run, the tool detects the resulting `404 Task not found` or connection error at any stage (submit / poll / fetch), then waits for the server to come back online (polling `/health` with exponential back-off, up to 30 minutes) and automatically resubmits the task. No manual intervention is required.

**Check if a PDF is already done (PowerShell):**
```powershell
$j = Get-Content "staging\pdfjobs\myfile.pdf.json" | ConvertFrom-Json
"done=$($j.chunks.Where({$_.status -eq 'completed'}).Count) mergeComplete=$($j.mergeComplete)"
```

**Force re-process** by deleting the checkpoint:
```powershell
Remove-Item "staging\pdfjobs\myfile.pdf.json"
```

---

## Multi-language Support

Set `MINERU_LANG` to a comma-separated list of BCP 47-style language codes:

| Code | Language |
|---|---|
| `ch` | Chinese (Simplified) |
| `en` | English |
| `ch,en` | Chinese + English (mixed documents) |
| `ja` | Japanese |
| `ko` | Korean |

Example for a bilingual document:
```powershell
$env:MINERU_LANG = "ch,en"
node mineru-client.js raw staging
```

---

## LLM Wiki Integration

This tool is designed to work with an [LLM Wiki](CLAUDE.md) system where a locally-deployed LLM (e.g. Claude) maintains an Obsidian knowledge base from PDF sources.

**Workflow:**

```
raw/{name}.pdf
  → node mineru-client.js raw staging
  → staging/{name}.md          (read this for wiki synthesis)
  → wiki/{topic}.md            (create/update wiki pages)
```

**Trigger phrase** — when you tell the LLM "请更新 wiki" or "I updated a document", it will:
1. Detect new PDFs in `raw/`
2. Check checkpoints — skip already-processed files
3. Run `node ./mineru-client.js raw staging`
4. Read `staging/{name}.md` in sections
5. Synthesize and update wiki pages in `wiki/`
6. Update `wiki/index.md` and `wiki/log.md`

See [CLAUDE.md](CLAUDE.md) for the full LLM instruction set.

---

## Troubleshooting

### API unreachable

```
ERROR Health check failed: connect ECONNREFUSED 192.168.137.135:8000
```

- Verify the MinerU server is running: `curl http://192.168.137.135:8000/health`
- Check that the IP and port are correct; override with `MINERU_API_URL`

### Task times out

```
ERROR Task abc123 timed out after 1800s
```

- Large chunks on complex pages (dense tables, formulas) can take 5–10 minutes each
- Reduce `MINERU_CHUNK_SIZE` to 10 or fewer pages
- Re-run the command — completed chunks are skipped automatically

### Corrupt or empty output

- Enable debug mode to inspect raw API responses: `MINERU_DEBUG=1`
- Check which keys MinerU returns in the result; the client tries `md_content`, `markdown`, `md`, `content` in order
- If the `results` structure is unexpected, the debug log will show top-level and item keys

### Overlapping duplicate content in merged file

The merger automatically detects and removes duplicate lines at chunk boundaries. If you see `Dedup: removed N overlapping lines` in the log, this is expected and correct behavior.

### Starting fresh for one PDF

Delete its checkpoint and re-run:
```powershell
Remove-Item "staging\pdfjobs\myfile.pdf.json"
node mineru-client.js raw staging
```
