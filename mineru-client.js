#!/usr/bin/env node
/**
 * mineru-client.js — MinerU PDF Parsing Client
 *
 * Self-contained Node.js CLI tool with NO third-party dependencies.
 * Batch-parses PDFs via MinerU's async API with page-chunk checkpointing,
 * image extraction, and Obsidian-friendly Markdown output.
 *
 * Usage:
 *   node mineru-client.js <input_path> <output_dir> [checkpoint_start]
 *
 *   input_path       A single file (PDF/DOCX/PPTX/PPT/DOC) or a directory of such files
 *   output_dir       Directory for all output files
 *   checkpoint_start Filename to resume from when input_path is a directory (optional)
 *
 * Output layout (inside output_dir):
 *   {stem}.md                              Final merged Markdown  ({stem} = filename without extension)
 *   {stem}_result/
 *     markdowns/chunk_XXXX_XXXX.md        Per-chunk intermediate Markdown
 *     images/{prefix}_{imgname}.{ext}     Extracted images (prefixed by chunk id)
 *   pdfjobs/{filename}.json               Checkpoint file  ({filename} = full filename with extension)
 *
 * Environment variables:
 *   MINERU_API_URL     API base URL          (default: http://192.168.137.135:8000)
 *   MINERU_CHUNK_SIZE  Pages per chunk       (default: 50)
 *   MINERU_LANG        Languages, CSV        (default: ch,en)
 *   MINERU_BACKEND     Backend engine        (default: hybrid-auto-engine)
 *   MINERU_MAX_CHUNKS  Max chunks per PDF    (default: 200  = 4000 pages)
 *   MINERU_DEBUG       1 to print raw JSON   (default: 0)
 */
'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const zlib    = require('zlib');

// ─── Configuration ────────────────────────────────────────────────────────────

const CFG = {
  apiUrl:                process.env.MINERU_API_URL                  || 'http://192.168.137.135:8000',
  chunkSize:             parseInt(process.env.MINERU_CHUNK_SIZE       || '50',  10),
  maxChunks:             parseInt(process.env.MINERU_MAX_CHUNKS       || '200', 10),
  // Documents with a detected page count at or below this threshold are sent as a
  // single task (no chunking), eliminating repeated full-file uploads.
  // Set to 0 to always use chunked mode regardless of page count.
  singleChunkThreshold:  parseInt(process.env.MINERU_SINGLE_CHUNK_THRESHOLD || '1000', 10),
  langList:              (process.env.MINERU_LANG    || 'ch,en').split(',').map(s => s.trim()),
  backend:               process.env.MINERU_BACKEND  || 'hybrid-auto-engine',
  debug:                 process.env.MINERU_DEBUG === '1',
  pollStartMs:           3000,
  pollMaxMs:             10000,
  pollTimeoutMs:         parseInt(process.env.MINERU_POLL_TIMEOUT_MS  || String(30 * 60 * 1000), 10),
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }
function log(msg)      { process.stdout.write(`[${ts()}] ${msg}\n`); }
function logWarn(msg)  { process.stderr.write(`[${ts()}] WARN  ${msg}\n`); }
function logError(msg) { process.stderr.write(`[${ts()}] ERROR ${msg}\n`); }
function logDebug(msg) { if (CFG.debug) process.stdout.write(`[${ts()}] DEBUG ${msg}\n`); }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

/**
 * Low-level HTTP request returning {statusCode, headers, body (Buffer), text}.
 */
function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const lib = (options.protocol === 'https:') ? https : http;
    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => {
        const buf = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Build a multipart/form-data body from text fields and file entries.
 * fields: [ [name, value], ... ]           (strings; arrays use same name repeated)
 * files:  [ {name, filename, contentType, data (Buffer)}, ... ]
 * Returns { body: Buffer, contentType: string }
 */
function buildMultipart(fields, files) {
  const boundary = '----MinerUBoundary' + crypto.randomBytes(16).toString('hex');
  const CRLF = '\r\n';
  const parts = [];

  for (const [name, value] of fields) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`,
      'utf8'
    ));
    parts.push(Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from(CRLF, 'utf8'));
  }

  for (const { name, filename, contentType, data } of files) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}` +
      `Content-Type: ${contentType}${CRLF}${CRLF}`,
      'utf8'
    ));
    parts.push(data);
    parts.push(Buffer.from(CRLF, 'utf8'));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(parts);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Parse API base URL into request option parts. */
function parseApiBase() {
  const u = new URL(CFG.apiUrl);
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port:     u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
  };
}

async function apiGet(urlPath) {
  const base = parseApiBase();
  const res = await makeRequest({ ...base, path: urlPath, method: 'GET' });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`GET ${urlPath} → HTTP ${res.statusCode}: ${res.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`GET ${urlPath} → non-JSON response: ${res.text.slice(0, 300)}`);
  }
}

async function apiPostMultipart(urlPath, fields, files) {
  const { body, contentType } = buildMultipart(fields, files);
  const base = parseApiBase();
  const res = await makeRequest(
    { ...base, path: urlPath, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length } },
    body
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`POST ${urlPath} → HTTP ${res.statusCode}: ${res.text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`POST ${urlPath} → non-JSON response: ${res.text.slice(0, 300)}`);
  }
}

// ─── MinerU API Functions ─────────────────────────────────────────────────────

async function healthCheck() {
  try {
    const r = await apiGet('/health');
    log(`Health check OK: ${JSON.stringify(r)}`);
    return true;
  } catch (err) {
    logError(`Health check failed: ${err.message}`);
    return false;
  }
}

/**
 * Submit an async parse task and return the task_id string.
 */
async function submitTask(pdfPath, startPage, endPage) {
  const pdfData     = fs.readFileSync(pdfPath);
  const pdfFilename = path.basename(pdfPath);

  // Build form fields — list params (lang_list) use repeated field name
  const fields = [
    ...CFG.langList.map(lang => ['lang_list', lang]),
    ['backend',             CFG.backend],
    ['parse_method',        'auto'],
    ['formula_enable',      'true'],
    ['table_enable',        'true'],
    ['image_analysis',      'true'],
    ['return_md',           'true'],
    ['return_images',       'true'],
    ['return_middle_json',  'false'],
    ['return_model_output', 'false'],
    ['return_content_list', 'false'],
    ['response_format_zip', 'false'],
    ['start_page_id',       String(startPage)],
    ['end_page_id',         String(endPage)],
  ];

  const files = [{
    name: 'files', filename: pdfFilename,
    contentType: 'application/pdf', data: pdfData,
  }];

  const result = await apiPostMultipart('/tasks', fields, files);
  logDebug(`submitTask response: ${JSON.stringify(result)}`);

  // task_id field name may vary across versions
  const taskId = result.task_id || result.id || (result.data && result.data.task_id);
  if (!taskId) {
    throw new Error(`Cannot find task_id in response: ${JSON.stringify(result).slice(0, 400)}`);
  }
  return String(taskId);
}

/**
 * Poll task status until done or failed. Returns 'done'.
 * Throws on timeout or failure.
 */
async function pollTaskStatus(taskId) {
  const deadline = Date.now() + CFG.pollTimeoutMs;
  let interval   = CFG.pollStartMs;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Task ${taskId} timed out after ${CFG.pollTimeoutMs / 1000}s`);
    }

    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), CFG.pollMaxMs);

    let statusResult;
    try {
      statusResult = await apiGet(`/tasks/${taskId}`);
    } catch (err) {
      // 404 "Task not found" means the server was restarted and lost the task.
      // Retrying the same task ID is pointless — propagate so caller can resubmit.
      if (err.message.includes('404') && err.message.includes('Task not found')) {
        throw err;
      }
      logWarn(`Poll error for ${taskId}: ${err.message} — retrying`);
      continue;
    }

    logDebug(`Poll ${taskId}: ${JSON.stringify(statusResult)}`);

    // Status field name may vary
    const status = (
      statusResult.status ||
      statusResult.state  ||
      statusResult.task_status || ''
    ).toLowerCase();

    log(`    Task ${taskId}: ${status}`);

    if (status === 'done' || status === 'completed' || status === 'success') {
      return 'done';
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Task ${taskId} failed: ${JSON.stringify(statusResult).slice(0, 400)}`);
    }
    // pending / running / processing → keep polling
  }
}

async function fetchTaskResult(taskId) {
  const result = await apiGet(`/tasks/${taskId}/result`);
  logDebug(`fetchTaskResult top-level keys: [${Object.keys(result).join(', ')}]`);
  return result;
}

// ─── File System Helpers ──────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Create all required subdirectories for a given PDF.
 * Returns an object with the key paths.
 */
function ensurePdfDirs(outputDir, pdfName) {
  const stem         = path.basename(pdfName, path.extname(pdfName));
  const resultDir    = path.join(outputDir, stem + '_result');
  const markdownsDir = path.join(resultDir, 'markdowns');
  const imagesDir    = path.join(resultDir, 'images');
  const jobsDir      = path.join(outputDir, 'pdfjobs');
  ensureDir(markdownsDir);
  ensureDir(imagesDir);
  ensureDir(jobsDir);
  return { resultDir, markdownsDir, imagesDir, jobsDir };
}

// ─── Checkpoint System ────────────────────────────────────────────────────────

/**
 * Build an array of chunk descriptors covering [0 … maxChunks*chunkSize-1] pages.
 * Processing stops early when a chunk returns no content (remainder are skipped).
 */
function buildChunks(chunkSize, maxChunks) {
  const chunks = [];
  for (let i = 0; i < maxChunks; i++) {
    chunks.push({
      chunkId:    i,
      startPage:  i * chunkSize,
      endPage:    i * chunkSize + chunkSize - 1,
      status:     'pending',   // pending | completed | skipped | failed
      imageFiles: [],
    });
  }
  return chunks;
}

function cpPath(jobsDir, pdfName) {
  return path.join(jobsDir, pdfName + '.json');
}

function loadCheckpoint(jobsDir, pdfName) {
  const p = cpPath(jobsDir, pdfName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    logWarn(`Corrupt checkpoint for ${pdfName}, starting fresh`);
    return null;
  }
}

function initCheckpoint(pdfName, filePath) {
  const pageCount = filePath ? readFilePageCount(filePath) : null;

  let chunks;
  let chunkSize;

  if (pageCount != null && CFG.singleChunkThreshold > 0 && pageCount <= CFG.singleChunkThreshold) {
    // Small-enough document: send all pages in one task.
    // Avoids uploading the full file once per chunk and eliminates merge/dedup overhead.
    chunks    = [{ chunkId: 0, startPage: 0, endPage: pageCount - 1, status: 'pending', imageFiles: [] }];
    chunkSize = pageCount;
  } else {
    const neededChunks = pageCount != null
      ? Math.ceil(pageCount / CFG.chunkSize)
      : CFG.maxChunks;
    const actualChunks = Math.min(Math.max(neededChunks, 1), CFG.maxChunks);
    chunks    = buildChunks(CFG.chunkSize, actualChunks);
    chunkSize = CFG.chunkSize;
  }

  return {
    pdfName,
    pageCount,
    chunkSize,
    chunks,
    pdfComplete:   false,
    mergeComplete: false,
    lastUpdated:   new Date().toISOString(),
  };
}

/** Atomic write: write to .tmp then rename (safe against power loss mid-write). */
function saveCheckpoint(jobsDir, checkpoint) {
  checkpoint.lastUpdated = new Date().toISOString();
  const p   = cpPath(jobsDir, checkpoint.pdfName);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ─── Image Processing ─────────────────────────────────────────────────────────

/**
 * Save images from API response to disk.
 * imagesMap: { "originalName.png": "<base64 data>", ... }
 * Returns a mapping { originalName → savedFilename } (filename only, no path).
 * Saved files are prefixed with chunk id to avoid cross-chunk collisions.
 * Existing files are overwritten (per spec: resume overwrites images).
 */
function saveImages(imagesMap, imagesDir, chunkId) {
  const nameMap = {};
  if (!imagesMap || typeof imagesMap !== 'object') return nameMap;

  for (const [origKey, b64] of Object.entries(imagesMap)) {
    if (typeof b64 !== 'string' || b64.length === 0) continue;

    const origBase = path.basename(origKey);                   // strip any sub-path
    const ext      = path.extname(origBase) || '.png';
    const stem     = path.basename(origBase, ext);
    const newName  = `chunk${String(chunkId).padStart(4, '0')}_${stem}${ext}`;
    const destPath = path.join(imagesDir, newName);

    try {
      // API may return data URIs ("data:image/png;base64,<data>") — strip the prefix
      const dataUriMatch = b64.match(/^data:[^;]+;base64,(.+)$/s);
      const rawB64 = dataUriMatch ? dataUriMatch[1] : b64;
      fs.writeFileSync(destPath, Buffer.from(rawB64, 'base64'));
      // Register both the bare basename and original key for rewrite lookup
      nameMap[origBase] = newName;
      nameMap[origKey]  = newName;
    } catch (err) {
      logWarn(`Failed to save image ${newName}: ${err.message}`);
    }
  }
  return nameMap;
}

/**
 * Rewrite all ![alt](imgPath) references in markdown.
 * - Resolves image to local file via nameMap
 * - Ensures alt text is non-empty (falls back to descriptive prefix + filename)
 * - Output path is relative to output_dir: "{stem}_result/images/{newName}"
 *   where stem = filename without extension
 *   (correct for the final merged MD file placed directly in output_dir)
 */
function rewriteImagePaths(markdown, nameMap, pdfName) {
  if (!markdown) return '';
  const stem   = path.basename(pdfName, path.extname(pdfName));
  const imgDir = `${stem}_result/images`;

  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, imgPath) => {
    const base    = path.basename(imgPath);
    const newName = nameMap[base] || nameMap[imgPath];
    const desc    = alt.trim() || `图片: ${newName || base}`;

    if (newName) {
      return `![${desc}](${imgDir}/${newName})`;
    }
    // Image not found in map — keep original path but fix alt text
    return `![${desc}](${imgPath})`;
  });
}

// ─── Chunk Markdown Naming ────────────────────────────────────────────────────

function chunkMdFilename(chunk) {
  const s = String(chunk.startPage).padStart(4, '0');
  const e = String(chunk.endPage).padStart(4, '0');
  return `chunk_${s}_${e}.md`;
}
/**
 * Normalize markdown for content-based deduplication.
 * Strips image tags (which contain chunk-specific prefixes) and collapses whitespace
 * so that identical page content from different chunks produces the same hash.
 */
function normalizeContent(md) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[IMG]')  // collapse all image references
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return an MD5 hex hash of the normalised content (for EOF/duplicate detection).
 */
function contentHashOf(markdown) {
  return crypto.createHash('md5').update(normalizeContent(markdown)).digest('hex');
}

// ─── Page Count Detection ────────────────────────────────────────────────────

/**
 * Attempt to read the page/slide count from a file without external libraries.
 * For PDF: scans raw bytes for /Count entries in the page tree.
 * Other types: returns null (falls back to maxChunks).
 */
function readFilePageCount(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.pdf') return null;
  try {
    const buf  = fs.readFileSync(filePath);
    const str  = buf.toString('latin1');
    const counts = new Set();

    const collectCounts = src => {
      for (const m of src.matchAll(/\/Count\s+(\d+)/g)) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n < 100000) counts.add(n);
      }
    };

    // Pass 1: scan uncompressed content (PDF ≤1.4, or uncompressed objects in PDF 1.5+)
    collectCounts(str);

    // Pass 2: decompress FlateDecode streams.
    // PDF 1.5+ stores the Pages root object inside compressed object streams (ObjStm),
    // so the root /Count is only visible after inflation. Skip streams > 2 MB.
    const streamRe = /\/FlateDecode[\s\S]{0,1024}?stream\r?\n([\s\S]{1,2097152}?)endstream/g;
    let sm;
    while ((sm = streamRe.exec(str)) !== null) {
      const raw = Buffer.from(sm[1], 'latin1');
      let inflated;
      try      { inflated = zlib.inflateSync(raw).toString('latin1'); }
      catch(e) { try { inflated = zlib.inflateRawSync(raw).toString('latin1'); } catch { continue; } }
      collectCounts(inflated);
    }

    return counts.size > 0 ? Math.max(...counts) : null;
  } catch {
    return null;
  }
}
// ─── Chunk Merging with Overlap Deduplication ─────────────────────────────────

/**
 * Find how many non-blank lines at the end of prevLines overlap with the
 * start of nextLines. Returns the overlap count (0 if none).
 * maxCheck caps how many lines to examine (prevents O(n²) on large docs).
 */
function findOverlapLines(prevLines, nextLines, maxCheck = 30) {
  const checkLen = Math.min(maxCheck, prevLines.length, nextLines.length);
  for (let len = checkLen; len > 0; len--) {
    const tail = prevLines.slice(prevLines.length - len);
    const head = nextLines.slice(0, len);
    // All compared lines must be non-empty and match
    if (tail.every((line, i) => {
      const l = line.trim();
      return l !== '' && l === head[i].trim();
    })) {
      return len;
    }
  }
  return 0;
}

/**
 * Read all completed chunk MDs in order and merge with deduplication.
 * Returns the merged Markdown string.
 */
function mergeChunks(outputDir, pdfName, checkpoint) {
  const stem         = path.basename(pdfName, path.extname(pdfName));
  const markdownsDir = path.join(outputDir, stem + '_result', 'markdowns');
  let merged     = '';
  let prevLines  = [];

  for (const chunk of checkpoint.chunks) {
    if (chunk.status !== 'completed') continue;

    const mdFile = path.join(markdownsDir, chunkMdFilename(chunk));
    if (!fs.existsSync(mdFile)) {
      logWarn(`Missing chunk file: ${chunkMdFilename(chunk)} — skipping`);
      continue;
    }

    const content   = fs.readFileSync(mdFile, 'utf8');
    const nextLines = content.split('\n');

    if (prevLines.length > 0 && nextLines.length > 0) {
      const overlap = findOverlapLines(prevLines, nextLines);
      if (overlap > 0) {
        log(`    Dedup: removed ${overlap} overlapping lines at chunk ${chunk.chunkId}`);
        const dedupedContent = nextLines.slice(overlap).join('\n');
        merged += (merged.endsWith('\n') ? '' : '\n') + dedupedContent + '\n';
        prevLines = nextLines.slice(overlap);
      } else {
        // Ensure a blank line between chunks for Markdown section separation
        if (merged.length > 0 && !merged.endsWith('\n\n')) {
          merged += '\n';
        }
        merged    += content + '\n';
        prevLines  = nextLines;
      }
    } else {
      merged    += content + '\n';
      prevLines  = nextLines;
    }
  }

  return merged;
}

// ─── Server Recovery ────────────────────────────────────────────────────────

/**
 * Poll /health until the server responds OK or the timeout elapses.
 * Call this before resubmitting after a server-restart error.
 */
async function waitForServer() {
  const WAIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let interval = 5000;
  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(Math.round(interval * 1.5), 30000);
    try {
      await apiGet('/health');
      log('    Server is back online — resubmitting task');
      return;
    } catch {
      logWarn(`    Server still unavailable — retrying in ${Math.round(interval / 1000)}s`);
    }
  }
  throw new Error('Server did not recover within 30 minutes');
}

/** Return true if the error looks like a server restart / 404 task-lost. */
function isServerRestartError(err) {
  const msg = err.message || '';
  return msg.includes('404') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET') ||
         msg.includes('ETIMEDOUT') || msg.includes('socket hang up');
}

// ─── Core Chunk Processing ────────────────────────────────────────────────────

/**
 * Process a single chunk: submit task → poll → fetch result → save images → save MD.
 * Handles MinerU server restarts (Docker container restarts) at every step:
 * if 404 / connection error is received, waits for the server to recover then resubmits.
 * Returns { hasContent: bool, imageFiles: string[] }.
 */
async function processChunk(pdfPath, chunk, dirs, checkpoint) {
  log(`  Chunk ${chunk.chunkId}: pages ${chunk.startPage}–${chunk.endPage}`);

  const MAX_ATTEMPTS = 20; // generous: Docker restarts can take time
  let result;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logWarn(`    Retrying chunk ${chunk.chunkId} (attempt ${attempt}/${MAX_ATTEMPTS})`);
    }

    // ── Submit ──────────────────────────────────────────────────────────────
    let taskId;
    try {
      taskId = await submitTask(pdfPath, chunk.startPage, chunk.endPage);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isServerRestartError(err)) {
        logWarn(`    Submit failed (${err.message}) — server may be restarting`);
        await waitForServer();
        continue;
      }
      throw err;
    }
    log(`    Task submitted: ${taskId}`);

    // ── Poll ────────────────────────────────────────────────────────────────
    try {
      await pollTaskStatus(taskId);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isServerRestartError(err)) {
        logWarn(`    Task ${taskId} lost — server restarted (${err.message})`);
        await waitForServer();
        continue;
      }
      throw err;
    }
    log(`    Task done: ${taskId}`);

    // ── Fetch result ────────────────────────────────────────────────────────
    try {
      result = await fetchTaskResult(taskId);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isServerRestartError(err)) {
        logWarn(`    Fetch result failed (${err.message}) — server may have restarted`);
        await waitForServer();
        continue;
      }
      throw err;
    }
    break; // success
  }

  // On first chunk, print result structure to help debug unknown field names
  if (chunk.chunkId === 0 || CFG.debug) {
    log(`    Result top-level keys: [${Object.keys(result).join(', ')}]`);
  }

  // MinerU returns one of:
  //   A) { backend, version, results: { "stem": { md_content, images } } }  (v3.x)
  //   B) { backend, version, results: [ { markdown, images, ... } ] }       (older)
  //   C) { markdown, images, ... }                                           (flat)
  let item = result;
  if (result.results !== undefined) {
    if (Array.isArray(result.results)) {
      item = result.results[0] || {};
    } else if (typeof result.results === 'object') {
      // Keyed by file stem (filename without extension)
      item = Object.values(result.results)[0] || {};
    }
  }

  if (chunk.chunkId === 0 || CFG.debug) {
    log(`    item keys: [${Object.keys(item).join(', ')}]`);
  }

  // Extract markdown — field name varies across API versions
  const markdown =
    item.md_content ||
    item.markdown   ||
    item.md         ||
    item.content    ||
    '';

  // Extract images map: { "filename.png": "<base64>" }
  const imagesMap =
    item.images      ||
    item.image_data  ||
    {};

  const hasContent = typeof markdown === 'string' && markdown.trim().length > 10;

  if (!hasContent) {
    log(`    Chunk ${chunk.chunkId}: no content returned — EOF reached`);
    return { hasContent: false, imageFiles: [] };
  }

  // Save images
  const nameMap     = saveImages(imagesMap, dirs.imagesDir, chunk.chunkId);
  const imageFiles  = Object.values(nameMap).filter((v, i, a) => a.indexOf(v) === i); // unique
  log(`    Saved ${imageFiles.length} image(s)`);

  // Rewrite image paths in markdown and save chunk MD
  const rewritten   = rewriteImagePaths(markdown, nameMap, checkpoint.pdfName);
  const chunkMdPath = path.join(dirs.markdownsDir, chunkMdFilename(chunk));
  fs.writeFileSync(chunkMdPath, rewritten, 'utf8');
  log(`    Saved: ${chunkMdFilename(chunk)}`);

  // Content hash for EOF/duplicate detection (normalised: image tags stripped)
  const contentHash = contentHashOf(markdown);
  return { hasContent: true, contentHash, imageFiles };
}

// ─── PDF-level Processing ─────────────────────────────────────────────────────

async function processPdf(pdfPath, outputDir) {
  const pdfName = path.basename(pdfPath);
  log(`\n${'─'.repeat(60)}`);
  log(`Processing: ${pdfName}`);

  const dirs       = ensurePdfDirs(outputDir, pdfName);
  let   checkpoint = loadCheckpoint(dirs.jobsDir, pdfName);

  if (!checkpoint) {
    checkpoint = initCheckpoint(pdfName, pdfPath);
    saveCheckpoint(dirs.jobsDir, checkpoint);
    const pgInfo = checkpoint.pageCount != null ? ` (detected ${checkpoint.pageCount} pages)` : '';
    const chunkDesc = checkpoint.chunks.length === 1 && checkpoint.pageCount != null
      ? `1 chunk — all pages in one request (single-chunk mode)`
      : `${checkpoint.chunks.length} chunk(s), ${checkpoint.chunkSize} pages/chunk`;
    log(`  New checkpoint: ${chunkDesc}${pgInfo}`);
  } else {
    const done  = checkpoint.chunks.filter(c => c.status === 'completed').length;
    const skip  = checkpoint.chunks.filter(c => c.status === 'skipped').length;
    const total = checkpoint.chunks.length;
    log(`  Resuming: ${done} done / ${skip} skipped / ${total} total chunks`);
  }

  if (checkpoint.mergeComplete) {
    log(`  Already fully complete — skipping`);
    return;
  }

  // Build the set of already-seen content hashes from completed chunks (supports resume).
  // Saved chunk files have rewritten image paths, so we normalise them the same way.
  const seenHashes = new Set();
  {
    const done = checkpoint.chunks.filter(c => c.status === 'completed');
    for (const doneChunk of done) {
      const mdFile = path.join(dirs.markdownsDir, chunkMdFilename(doneChunk));
      if (fs.existsSync(mdFile)) {
        const prev = fs.readFileSync(mdFile, 'utf8');
        seenHashes.add(contentHashOf(prev));
      }
    }
    if (seenHashes.size > 0) {
      log(`  Seeded ${seenHashes.size} content hash(es) from completed chunks`);
    }
  }

  // Process all pending chunks
  for (const chunk of checkpoint.chunks) {
    if (chunk.status === 'completed' || chunk.status === 'skipped') continue;

    let result;
    try {
      result = await processChunk(pdfPath, chunk, dirs, checkpoint);
    } catch (err) {
      logError(`  Chunk ${chunk.chunkId} error: ${err.message}`);
      chunk.status = 'failed';
      saveCheckpoint(dirs.jobsDir, checkpoint);
      throw new Error(`${pdfName} aborted at chunk ${chunk.chunkId}: ${err.message}`);
    }

    if (result.hasContent) {
      // Duplicate-content check: MinerU repeats document content for page ranges beyond EOF.
      // Normalised hashes strip chunk-specific image prefixes so identical pages always match.
      if (result.contentHash && seenHashes.has(result.contentHash)) {
        log(`  Chunk ${chunk.chunkId}: duplicate content — past end of document (EOF)`);
        const idx = checkpoint.chunks.indexOf(chunk);
        for (let i = idx; i < checkpoint.chunks.length; i++) {
          checkpoint.chunks[i].status = 'skipped';
        }
        saveCheckpoint(dirs.jobsDir, checkpoint);
        break;
      }
      seenHashes.add(result.contentHash);
      chunk.status     = 'completed';
      chunk.imageFiles = result.imageFiles;
    } else {
      // EOF — mark this chunk and all remaining as skipped
      const idx = checkpoint.chunks.indexOf(chunk);
      for (let i = idx; i < checkpoint.chunks.length; i++) {
        checkpoint.chunks[i].status = 'skipped';
      }
      break;
    }

    checkpoint.pdfComplete = checkpoint.chunks.every(
      c => c.status === 'completed' || c.status === 'skipped'
    );
    saveCheckpoint(dirs.jobsDir, checkpoint);
  }

  // Merge all completed chunks into final MD
  const completed = checkpoint.chunks.filter(c => c.status === 'completed');
  if (completed.length === 0) {
    logWarn(`  No chunks completed for ${pdfName} — no output generated`);
    return;
  }

  log(`  Merging ${completed.length} chunk(s) into final Markdown...`);
  const merged      = mergeChunks(outputDir, pdfName, checkpoint);
  const finalMdName = path.basename(pdfName, path.extname(pdfName)) + '.md';
  const finalMdPath = path.join(outputDir, finalMdName);
  fs.writeFileSync(finalMdPath, merged, 'utf8');
  log(`  Final Markdown: ${finalMdName} (${(merged.length / 1024).toFixed(1)} KB)`);

  checkpoint.mergeComplete = true;
  checkpoint.pdfComplete   = true;
  saveCheckpoint(dirs.jobsDir, checkpoint);
  log(`  ${pdfName} ✓`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    process.stderr.write([
      'Usage: node mineru-client.js <input_path> <output_dir> [checkpoint_start]',
      '',
      '  input_path        A single file or a directory of files (PDF, DOCX, DOC, PPTX, PPT)',
      '  output_dir        Directory for output files',
      '  checkpoint_start  Filename to resume from (directory mode only, optional)',
      '',
      'Environment variables:',
      '  MINERU_API_URL     API base URL          (default: http://192.168.137.135:8000)',
      '  MINERU_CHUNK_SIZE  Pages per chunk       (default: 5)',
      '  MINERU_LANG        Languages, CSV        (default: ch,en)',
      '  MINERU_BACKEND     Backend engine        (default: hybrid-auto-engine)',
      '  MINERU_MAX_CHUNKS                Max chunks per PDF          (default: 200)',
      '  MINERU_SINGLE_CHUNK_THRESHOLD    Max pages for single-task   (default: 1000, 0=always chunk)',
      '  MINERU_POLL_TIMEOUT_MS           Per-task timeout in ms      (default: 1800000 = 30 min)',
      '  MINERU_DEBUG                     1 for verbose output        (default: 0)',
      '',
    ].join('\n'));
    process.exit(1);
  }

  const inputPath       = path.resolve(args[0]);
  const outputDir       = path.resolve(args[1]);
  const checkpointStart = args[2] || null;

  if (!fs.existsSync(inputPath)) {
    logError(`Input path not found: ${inputPath}`);
    process.exit(1);
  }

  const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt']);
  const isSupportedExt = f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase());

  const inputStat    = fs.statSync(inputPath);
  const isSingleFile = inputStat.isFile();

  if (isSingleFile && !isSupportedExt(inputPath)) {
    logError(`Unsupported file type: ${path.extname(inputPath)}. Supported: ${[...SUPPORTED_EXTS].join(', ')}`);
    process.exit(1);
  }

  const inputDir = isSingleFile ? path.dirname(inputPath) : inputPath;
  const allFiles = isSingleFile
    ? [path.basename(inputPath)]
    : fs.readdirSync(inputPath).filter(isSupportedExt).sort();

  ensureDir(outputDir);

  log('MinerU Client');
  log(`  API:        ${CFG.apiUrl}`);
  log(`  Input:      ${inputPath}`);
  log(`  Output dir: ${outputDir}`);
  log(`  Chunk size: ${CFG.chunkSize} pages`);
  log(`  Max chunks: ${CFG.maxChunks} (${CFG.maxChunks * CFG.chunkSize} pages max)`);
  log(`  Single-chunk threshold: ${CFG.singleChunkThreshold > 0 ? `≤${CFG.singleChunkThreshold} pages` : 'disabled'}`);
  log(`  Languages:  ${CFG.langList.join(', ')}`);
  log(`  Backend:    ${CFG.backend}`);
  if (checkpointStart && !isSingleFile) log(`  Resume from: ${checkpointStart}`);

  // Health check
  const ok = await healthCheck();
  if (!ok) {
    logError('API server unreachable. Aborting.');
    process.exit(1);
  }

  if (allFiles.length === 0) {
    logError(`No supported files found in: ${inputPath}`);
    process.exit(1);
  }

  log(`Found ${allFiles.length} file(s): ${allFiles.join(', ')}`);

  // Determine start index for checkpoint_start (directory mode only)
  let startIdx = 0;
  if (!isSingleFile && checkpointStart) {
    const idx = allFiles.indexOf(checkpointStart);
    if (idx === -1) {
      logWarn(`"${checkpointStart}" not found in file list — starting from beginning`);
    } else {
      startIdx = idx;
    }
  }

  // Process each file
  let okCount   = 0;
  let failCount = 0;

  for (let i = startIdx; i < allFiles.length; i++) {
    const fileName = allFiles[i];
    const filePath = path.join(inputDir, fileName);
    try {
      await processPdf(filePath, outputDir);
      okCount++;
    } catch (err) {
      logError(`${fileName}: ${err.message}`);
      failCount++;
    }
  }

  if (allFiles.length > 1) {
    log(`\nBatch done — ${okCount} succeeded, ${failCount} failed`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  logError(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
