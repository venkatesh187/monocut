const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec, execSync } = require('child_process');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

const app = express();
const PORT = process.env.PORT || 3000;

const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegInstaller.path;
const FFPROBE_PATH = process.env.FFPROBE_PATH || ffprobeInstaller.path;

console.log(`[MONOCUT] FFmpeg: ${FFMPEG_PATH}`);
console.log(`[MONOCUT] FFprobe: ${FFPROBE_PATH}`);

// App directories
const TEMP_DIR = path.join(__dirname, 'temp');
const EXPORT_DIR = path.join(__dirname, 'exports');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

[TEMP_DIR, EXPORT_DIR, UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configure Multer for instant high-speed file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safeName}`);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/exports', express.static(EXPORT_DIR));
app.use('/temp', express.static(TEMP_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

const activeJobs = new Map();

// Hardware Acceleration & Encoder Detection Cache
let detectedH264Encoder = null; // 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'
let detectedHwaccel = null;     // 'auto' | null

function probeHardwareCapabilities() {
  if (detectedH264Encoder) return { encoder: detectedH264Encoder, hwaccel: detectedHwaccel };

  // 1. Probe Hardware Encoders (in priority order: NVENC -> QSV -> AMF -> software fallback)
  const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf'];
  for (const enc of candidates) {
    try {
      execSync(`"${FFMPEG_PATH}" -y -f lavfi -i color=c=black:s=256x256:d=0.1 -c:v ${enc} -f null -`, {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 2500
      });
      console.log(`[MONOCUT] Hardware encoder detected and verified: ${enc}`);
      detectedH264Encoder = enc;
      break;
    } catch (e) {}
  }

  if (!detectedH264Encoder) {
    console.log('[MONOCUT] No working hardware encoder found. Using software libx264.');
    detectedH264Encoder = 'libx264';
  }

  // 2. Probe Hardware Decode Acceleration
  try {
    execSync(`"${FFMPEG_PATH}" -y -hwaccel auto -f lavfi -i color=c=black:s=256x256:d=0.1 -f null -`, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 2500
    });
    detectedHwaccel = 'auto';
    console.log('[MONOCUT] Hardware decode acceleration verified: -hwaccel auto');
  } catch (e) {
    detectedHwaccel = null;
    console.log('[MONOCUT] Hardware decode acceleration not available. Using software decoding.');
  }

  return { encoder: detectedH264Encoder, hwaccel: detectedHwaccel };
}

// Initial probe on boot
probeHardwareCapabilities();

function getH264Encoder() {
  if (!detectedH264Encoder) probeHardwareCapabilities();
  return detectedH264Encoder;
}

function getHwaccel() {
  if (detectedH264Encoder === null) probeHardwareCapabilities();
  return detectedHwaccel;
}

/**
 * Cross-platform tree-kill for child processes
 */
function terminateProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
    } else {
      proc.kill('SIGKILL');
    }
  } catch (e) {}
}

/**
 * Clean up temporary chunk and concat list files for a given job safely on Windows/POSIX
 */
function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    // On Windows, if file handle release lags by a few ms, retry after 1.5s
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
    }, 1500);
  }
}

function cleanupJobTempFiles(jobId, tempFiles) {
  if (tempFiles) {
    for (const f of tempFiles) {
      safeUnlink(f);
    }
  }
  try {
    if (fs.existsSync(TEMP_DIR)) {
      const files = fs.readdirSync(TEMP_DIR);
      for (const f of files) {
        if (f.includes(jobId)) {
          safeUnlink(path.join(TEMP_DIR, f));
        }
      }
    }
  } catch (err) {}
}

// TTL Garbage Collection: Evict completed/failed/cancelled jobs after 30 minutes
const JOB_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    if (job.completedAt && (now - job.completedAt > JOB_TTL_MS)) {
      cleanupJobTempFiles(jobId, job.tempFiles);
      activeJobs.delete(jobId);
      console.log(`[MONOCUT] Evicted stale job ${jobId} from memory (TTL expired)`);
    }
  }
}, 5 * 60 * 1000);

/**
 * Fast search for a file across drives
 */
function findFileOnSystem(fileName, fileSize) {
  const commonDirs = [
    UPLOAD_DIR,
    EXPORT_DIR,
    __dirname,
    process.cwd(),
    'S:\\yt', 'V:\\yt', 'M:\\yt',
    'V:\\', 'M:\\', 'S:\\', 'D:\\', 'E:\\',
    path.join(os.homedir(), 'Downloads'),
    path.join(os.homedir(), 'Videos'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
    os.homedir(),
    'C:\\'
  ];

  const cleanTarget = fileName.toLowerCase().trim();

  // First pass: direct check
  for (const baseDir of commonDirs) {
    try {
      if (!fs.existsSync(baseDir)) continue;
      const direct = path.join(baseDir, fileName);
      if (fs.existsSync(direct)) return direct;

      const items = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isFile() && item.name.toLowerCase() === cleanTarget) {
          return path.join(baseDir, item.name);
        }
      }
    } catch (e) {}
  }

  // Second pass: recursive scan
  for (const baseDir of commonDirs) {
    try {
      if (!fs.existsSync(baseDir)) continue;
      const found = searchRecursive(baseDir, cleanTarget, 3, 0);
      if (found) return found;
    } catch (e) {}
  }

  return null;
}

function searchRecursive(dir, targetName, maxDepth, currentDepth) {
  if (currentDepth > maxDepth) return null;
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      const fullPath = path.join(dir, item.name);
      if (item.isFile() && item.name.toLowerCase() === targetName) {
        return fullPath;
      }
      if (item.isDirectory() && !item.name.startsWith('$') && !item.name.startsWith('.') && item.name !== 'node_modules' && item.name !== 'AppData' && item.name !== 'Windows') {
        const res = searchRecursive(fullPath, targetName, maxDepth, currentDepth + 1);
        if (res) return res;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Probe video metadata using FFprobe
 */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-print_format', 'json',
      filePath
    ];

    const proc = spawn(FFPROBE_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });

    proc.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`ffprobe error (code ${code}): ${stderr}`));
      }
      try {
        const info = JSON.parse(stdout);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video') || {};
        const audioStream = (info.streams || []).find(s => s.codec_type === 'audio') || {};

        let fps = 60;
        if (videoStream.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          if (parts.length === 2 && Number(parts[1]) > 0) {
            fps = Number(parts[0]) / Number(parts[1]);
          } else if (Number(parts[0]) > 0) {
            fps = Number(parts[0]);
          }
        }

        const duration = Number(info.format.duration) || Number(videoStream.duration) || 0;
        const width = Number(videoStream.width) || 1920;
        const height = Number(videoStream.height) || 1080;
        const sizeBytes = Number(info.format.size) || 0;
        const hasAudio = Boolean(audioStream && audioStream.codec_type === 'audio');

        resolve({
          filePath,
          fileName: path.basename(filePath),
          duration,
          width,
          height,
          fps: Math.round(fps * 1000) / 1000,
          aspectRatio: width / height,
          sizeBytes,
          formatName: info.format.format_name,
          videoCodec: videoStream.codec_name || 'vp9',
          audioCodec: audioStream.codec_name || null,
          hasAudio,
          bitrate: Number(info.format.bit_rate) || 0
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Route: Extract filmstrip frames for visual timeline
 */
app.get('/api/thumbnails', async (req, res) => {
  try {
    const filePath = req.query.path;
    const count = parseInt(req.query.count) || 36;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const baseName = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const thumbSubDir = `thumbs_${baseName}_c${count}`;
    const thumbDir = path.join(TEMP_DIR, thumbSubDir);
    if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

    const existing = fs.readdirSync(thumbDir).filter(f => f.endsWith('.jpg'));
    if (existing.length >= count) {
      const urls = existing.sort().map(f => `/temp/${thumbSubDir}/${f}`);
      return res.json({ thumbnails: urls });
    }

    const meta = await probeVideo(filePath);
    const duration = meta.duration || 10;

    const items = [];
    for (let i = 0; i < count; i++) {
      const time = Math.max(0, Math.min(duration - 0.5, (i / (count - 1)) * (duration - 1)));
      const fileName = `thumb_${String(i).padStart(3, '0')}.jpg`;
      const outPath = path.join(thumbDir, fileName);
      items.push({ index: i, time, fileName, outPath });
    }

    const results = new Array(count);
    const CONCURRENCY = 4;
    let currIdx = 0;

    async function worker() {
      while (currIdx < items.length) {
        const item = items[currIdx++];
        if (fs.existsSync(item.outPath)) {
          results[item.index] = `/temp/${thumbSubDir}/${item.fileName}`;
          continue;
        }

        await new Promise(resolve => {
          const proc = spawn(FFMPEG_PATH, [
            '-y',
            '-ss', String(item.time),
            '-noaccurate_seek',
            '-i', filePath,
            '-frames:v', '1',
            '-vf', 'scale=240:135',
            '-q:v', '5',
            '-threads', '2',
            item.outPath
          ]);
          proc.on('close', () => {
            results[item.index] = `/temp/${thumbSubDir}/${item.fileName}`;
            resolve();
          });
          proc.on('error', () => {
            results[item.index] = null;
            resolve();
          });
        });
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, items.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    const urls = results.filter(Boolean);
    res.json({ thumbnails: urls });

  } catch (err) {
    console.error('Thumbnails error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Route: Locate file on local PC
 */
app.post('/api/locate-file', async (req, res) => {
  const { fileName, fileSize } = req.body;
  if (!fileName) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  const realPath = findFileOnSystem(fileName, fileSize);
  if (!realPath) {
    return res.json({ found: false });
  }

  try {
    const meta = await probeVideo(realPath);
    res.json({ found: true, ...meta });
  } catch (err) {
    res.json({ found: true, filePath: realPath, fileName: path.basename(realPath) });
  }
});

/**
 * Route: High-Speed Direct Video Upload
 */
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    const realPath = req.file.path;
    const meta = await probeVideo(realPath);
    res.json({
      found: true,
      filePath: realPath,
      fileName: req.file.originalname,
      ...meta
    });
  } catch (err) {
    console.error('Upload processing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Strict allowlist of media extensions for streaming & inspection
const ALLOWED_STREAM_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v']);

/**
 * Route: Inspect / load a file by path
 */
app.post('/api/load-path', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    const resolvedPath = path.resolve(filePath);
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!ALLOWED_STREAM_EXTS.has(ext)) {
      return res.status(403).json({ error: 'Invalid media file extension' });
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return res.status(400).json({ error: 'File does not exist on disk' });
    }
    const meta = await probeVideo(resolvedPath);
    res.json(meta);
  } catch (err) {
    console.error('Error loading file by path:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Route: High-performance Byte-Range Streamer for 4K 60fps WebM / MP4
 */
app.get('/api/stream', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) {
    return res.status(400).send('Path parameter is required');
  }

  const resolvedPath = path.resolve(rawPath);
  const ext = path.extname(resolvedPath).toLowerCase();

  // Strict media extension security check
  if (!ALLOWED_STREAM_EXTS.has(ext)) {
    return res.status(403).send('Forbidden: Invalid media file extension');
  }

  // Canonical file existence & verification
  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).send('Video file not found');
  }

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).send('Invalid file path');
    }
  } catch (err) {
    return res.status(500).send('File access error');
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  let contentType = 'video/webm';
  if (ext === '.mp4' || ext === '.m4v') contentType = 'video/mp4';
  else if (ext === '.mkv') contentType = 'video/x-matroska';
  else if (ext === '.mov') contentType = 'video/quicktime';
  else if (ext === '.avi') contentType = 'video/x-msvideo';

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    // 8 MB range window for instant 4K seeking with 1 MB highWaterMark
    const chunkSize = 8 * 1024 * 1024;
    const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + chunkSize - 1, fileSize - 1);
    const chunkLength = (end - start) + 1;

    const stream = fs.createReadStream(resolvedPath, {
      start,
      end,
      highWaterMark: 1024 * 1024 // 1 MB internal buffer
    });

    const cleanUp = () => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    };
    req.on('close', cleanUp);
    res.on('close', cleanUp);
    stream.on('error', cleanUp);

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkLength,
      'Content-Type': contentType,
    });
    stream.pipe(res);
  } else {
    const stream = fs.createReadStream(resolvedPath, {
      highWaterMark: 1024 * 1024
    });

    const cleanUp = () => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    };
    req.on('close', cleanUp);
    res.on('close', cleanUp);
    stream.on('error', cleanUp);

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    stream.pipe(res);
  }
});

/**
 * Route: Open Explorer Folder for Exported Video
 */
app.post('/api/open-folder', (req, res) => {
  const { filePath } = req.body;
  const target = filePath && fs.existsSync(filePath) ? filePath : EXPORT_DIR;
  exec(`explorer.exe /select,"${target.replace(/\//g, '\\')}"`, (err) => {
    if (err) exec(`explorer.exe "${EXPORT_DIR.replace(/\//g, '\\')}"`);
    res.json({ status: 'ok' });
  });
});

/**
 * Route: SSE Progress Tracking
 */
app.get('/api/export-progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const job = activeJobs.get(jobId);
  if (job) {
    if (!job.sseClients) job.sseClients = new Set();
    job.sseClients.add(res);
  }

  const interval = setInterval(() => {
    const currentJob = activeJobs.get(jobId);
    if (!currentJob) {
      res.write(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`);
      clearInterval(interval);
      return res.end();
    }

    res.write(`data: ${JSON.stringify(currentJob)}\n\n`);

    if (currentJob.status === 'completed' || currentJob.status === 'error' || currentJob.status === 'cancelled') {
      clearInterval(interval);
      res.end();
    }
  }, 250);

  req.on('close', () => {
    clearInterval(interval);
    const j = activeJobs.get(jobId);
    if (j && j.sseClients) j.sseClients.delete(res);
  });
});

/**
 * Route: Polling fallback status for export job
 */
app.get('/api/export-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ status: 'not_found' });
  }
  res.json(job);
});

/**
 * Route: Cancel Running Export & Clean Up Temp Resources
 */
app.delete('/api/export/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  job.cancelled = true;
  job.status = 'cancelled';
  job.stage = 'Export cancelled by user';
  job.completedAt = Date.now();

  // Terminate all active FFmpeg processes (including parallel chunk workers)
  if (job.activeProcesses && job.activeProcesses.size > 0) {
    job.activeProcesses.forEach(proc => terminateProcessTree(proc));
    job.activeProcesses.clear();
  }
  if (job.currentProcess) {
    terminateProcessTree(job.currentProcess);
    job.currentProcess = null;
  }

  // Notify and close open SSE clients
  if (job.sseClients) {
    job.sseClients.forEach(client => {
      try {
        client.write(`data: ${JSON.stringify({ status: 'cancelled', stage: 'Export cancelled by user' })}\n\n`);
        client.end();
      } catch (e) {}
    });
    job.sseClients.clear();
  }

  // Asynchronously clean up any temporary chunk and manifest files
  setImmediate(() => {
    cleanupJobTempFiles(jobId, job.tempFiles);
  });

  res.json({ success: true, message: 'Export cancelled and temporary resources cleaned up' });
});

/**
 * Route: High-Speed Export Execution (God Speed Lossless / Max Compute Parallel Fast MP4 / Shorts 60fps)
 */
app.post('/api/export', async (req, res) => {
  try {
    const {
      sourcePath,
      segments,
      aspectRatio = '16:9',
      cropOffsetX = 0.5,
      panStart = 0.5,
      panEnd = 0.5,
      zoomScale = 1.0,
      mode = 'godspeed',
      outputFormat = 'mp4',
      resolution = 'source',
      customFileName = null
    } = req.body;

    let effectiveSource = (sourcePath && fs.existsSync(sourcePath)) ? sourcePath : null;
    if (!effectiveSource && sourcePath) {
      effectiveSource = findFileOnSystem(path.basename(sourcePath));
    }
    if (!effectiveSource && segments && Array.isArray(segments)) {
      for (const s of segments) {
        if (s.sourcePath) {
          if (fs.existsSync(s.sourcePath)) {
            effectiveSource = s.sourcePath;
            break;
          }
          const found = findFileOnSystem(path.basename(s.sourcePath));
          if (found) {
            effectiveSource = found;
            break;
          }
        }
      }
    }

    if (!effectiveSource || !fs.existsSync(effectiveSource)) {
      return res.status(400).json({ error: 'Source file does not exist on disk' });
    }

    if (!segments || !Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'At least one segment must be provided' });
    }

    // Ensure every segment has a resolved disk path
    const resolvedSegments = segments.map(seg => {
      let segSrc = seg.sourcePath || effectiveSource;
      if (segSrc && !fs.existsSync(segSrc)) {
        const found = findFileOnSystem(path.basename(segSrc));
        if (found) segSrc = found;
      }
      return {
        ...seg,
        sourcePath: segSrc || effectiveSource
      };
    });

    const meta = await probeVideo(effectiveSource);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const totalCutDuration = resolvedSegments.reduce((sum, seg) => sum + Math.max(0.05, (seg.end - seg.start) / (seg.speed || 1.0)), 0);

    const job = {
      jobId,
      status: 'processing',
      progress: 0,
      stage: 'Starting export...',
      speed: '0x',
      timeRemaining: '--',
      downloadUrl: null,
      fullOutputPath: null,
      error: null,
      currentProcess: null,
      activeProcesses: new Set(),
      cancelled: false,
      completedAt: null,
      tempFiles: new Set(),
      sseClients: new Set()
    };
    activeJobs.set(jobId, job);

    res.json({ jobId, totalCutDuration });

    runExportPipeline(jobId, {
      sourcePath: effectiveSource,
      meta,
      segments: resolvedSegments,
      aspectRatio,
      cropOffsetX,
      panStart,
      panEnd,
      zoomScale,
      mode,
      outputFormat,
      resolution,
      customFileName,
      totalCutDuration
    }).catch(err => {
      console.error(`Export error for ${jobId}:`, err);
      if (!job.cancelled) {
        job.status = 'error';
        job.error = err.message;
      }
      job.completedAt = Date.now();
      cleanupJobTempFiles(jobId, job.tempFiles);
    });

  } catch (err) {
    console.error('Export endpoint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Chained Audio Tempo Filter generator (supporting any custom speed from 0.05x to 16.0x)
function buildAudioTempoFilter(speed) {
  let s = Number(speed) || 1.0;
  const filters = [];
  while (s > 2.0) {
    filters.push('atempo=2.0');
    s /= 2.0;
  }
  while (s < 0.5) {
    filters.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1.0) > 0.001 || filters.length === 0) {
    filters.push('atempo=' + s.toFixed(4));
  }
  return filters.join(',');
}

/**
 * Supercharged God Speed & Max Compute Export Engine
 */
async function runExportPipeline(jobId, options) {
  const job = activeJobs.get(jobId);
  const {
    sourcePath,
    meta,
    segments,
    aspectRatio = '16:9',
    cropOffsetX = 0.5,
    panStart = 0.5,
    panEnd = 0.5,
    zoomScale = 1.0,
    mode = 'godspeed',
    outputFormat = 'mp4',
    resolution = 'source',
    customFileName,
    totalCutDuration
  } = options;

  const timestamp = Date.now();
  const baseName = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const srcExt = (path.extname(sourcePath) || '.webm').toLowerCase();

  // Multi-source, audio mute & speed alteration checks
  const hasMultipleSources = segments.some(s => s.sourcePath && s.sourcePath !== sourcePath);
  const anyMuted = segments.some(s => s.muted);
  const anySpeedChange = segments.some(s => s.speed && Math.abs(s.speed - 1.0) > 0.01);
  const allSameExt = segments.every(s => !s.sourcePath || path.extname(s.sourcePath).toLowerCase() === srcExt);
  const hasZoom = zoomScale && zoomScale > 1.05;
  const hasMotionPan = Math.abs(panEnd - panStart) > 0.05;

  // Determine output extension
  let outExt = '.mp4';
  if (outputFormat === 'webm') outExt = '.webm';
  else if (outputFormat === 'source') outExt = srcExt;

  // Output filename
  const cleanCustom = customFileName && customFileName.trim() ? customFileName.trim().replace(/[^a-zA-Z0-9_-]/g, '_') : null;
  const finalOutName = cleanCustom
    ? `${cleanCustom}_${timestamp}${outExt}`
    : `${baseName}_${aspectRatio === '9:16' ? 'shorts' : (mode === 'godspeed' ? 'cut' : 'export')}_${timestamp}${outExt}`;
  const finalOutPath = path.resolve(EXPORT_DIR, finalOutName);

  // Format compatibility check for stream copy
  const formatMatchesSource = (outputFormat === 'source') ||
                              (srcExt === '.webm' && outputFormat === 'webm') ||
                              (srcExt === '.mp4' && outputFormat === 'mp4') ||
                              (srcExt === '.mkv' && outputFormat === 'mkv');

  // Can we perform instant lossless stream copy ("God Speed" ~0.2s - 2s)?
  // High-speed stream copy supported across single or multiple clips / sources when container matches
  const canLossless = (mode === 'godspeed') &&
                      (aspectRatio === '16:9') &&
                      (resolution === 'source') &&
                      !hasZoom &&
                      !hasMotionPan &&
                      !anyMuted &&
                      allSameExt &&
                      formatMatchesSource;

  if (canLossless) {
    try {
      if (segments.length === 1) {
        const seg = segments[0];
        let segSrc = seg.sourcePath || sourcePath;
        if (!fs.existsSync(segSrc)) {
          const found = findFileOnSystem(path.basename(segSrc));
          if (found) segSrc = found;
        }
        const segDur = Math.max(0.05, seg.end - seg.start);
        const segSpeed = Number(seg.speed) || 1.0;
        const hasSpeed = Math.abs(segSpeed - 1.0) > 0.01;

        if (!hasSpeed) {
          job.stage = 'Executing ⚡ God Speed lossless stream cut (~0.2s)...';
          const args = [
            '-y',
            '-ss', String(seg.start),
            '-t', String(segDur),
            '-i', segSrc,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero'
          ];
          if (outExt === '.mp4' || outExt === '.mov') {
            args.push('-movflags', '+faststart');
          }
          args.push(finalOutPath);

          await runFfmpegCommand(args, job, segDur);
        } else {
          job.stage = `Applying ⚡ God Speed ${segSpeed}x speed scaling (~0.4s)...`;
          const segExt = (path.extname(segSrc) || srcExt).toLowerCase();
          const rawSlicePath = path.join(TEMP_DIR, `raw_${jobId}_0${segExt}`);
          job.tempFiles.add(rawSlicePath);

          try {
            // Step 1: Lossless slice
            const cutArgs = [
              '-y',
              '-ss', String(seg.start),
              '-t', String(segDur),
              '-i', segSrc,
              '-c', 'copy',
              '-avoid_negative_ts', 'make_zero',
              rawSlicePath
            ];
            await runFfmpegCommand(cutArgs, job, segDur);

            // Step 2: Stream-copy retiming with -itsscale and audio tempo filter
            let segHasAudio = true;
            try {
              const probe = await probeVideo(segSrc);
              segHasAudio = probe.hasAudio;
            } catch (e) {
              segHasAudio = true;
            }

            const speedScale = (1.0 / segSpeed).toFixed(6);
            const scaleArgs = [
              '-y',
              '-itsscale', speedScale,
              '-i', rawSlicePath,
              '-c:v', 'copy'
            ];

            if (segHasAudio) {
              const tempoFilter = buildAudioTempoFilter(segSpeed);
              scaleArgs.push(
                '-af', `${tempoFilter},aresample=48000:async=1`,
                ...(segExt === '.webm'
                  ? ['-c:a', 'libopus', '-b:a', '256k']
                  : ['-c:a', 'aac', '-b:a', '320k'])
              );
            }

            if (outExt === '.mp4' || outExt === '.mov') {
              scaleArgs.push('-movflags', '+faststart');
            }
            scaleArgs.push(finalOutPath);

            const scaledDur = segDur / segSpeed;
            await runFfmpegCommand(scaleArgs, job, scaledDur);
          } finally {
            safeUnlink(rawSlicePath);
          }
        }
      } else {
        job.stage = `Slicing ${segments.length} clips at ⚡ God Speed...`;
        const tempClips = [];
        const rawSlicesToClean = [];
        const concatListFile = path.join(TEMP_DIR, `concat_${jobId}.txt`);
        job.tempFiles.add(concatListFile);

        try {
          for (let i = 0; i < segments.length; i++) {
            if (job.cancelled) throw new Error('Export cancelled by user');

            const seg = segments[i];
            let segSrc = seg.sourcePath || sourcePath;
            if (!fs.existsSync(segSrc)) {
              const found = findFileOnSystem(path.basename(segSrc));
              if (found) segSrc = found;
            }
            const segDur = Math.max(0.05, seg.end - seg.start);
            const segExt = (path.extname(segSrc) || srcExt).toLowerCase();
            const segSpeed = Number(seg.speed) || 1.0;
            const hasSpeed = Math.abs(segSpeed - 1.0) > 0.01;
            const clipPath = path.join(TEMP_DIR, `clip_${jobId}_${i}${segExt}`);
            tempClips.push(clipPath);
            job.tempFiles.add(clipPath);

            const segBasePct = Math.round((i / segments.length) * 88);
            const segSpanPct = Math.round(88 / segments.length);
            const subJob = {
              set progress(pct) {
                job.progress = Math.min(90, Math.round(segBasePct + (pct / 100) * segSpanPct));
              },
              get currentTime() { return job.currentTime; },
              set currentTime(t) { job.currentTime = t; },
              get speed() { return job.speed; },
              set speed(s) { job.speed = s; },
              get timeRemaining() { return job.timeRemaining; },
              set timeRemaining(r) { job.timeRemaining = r; },
              get stage() { return job.stage; },
              set stage(s) { job.stage = s; },
              get cancelled() { return job.cancelled; },
              get currentProcess() { return job.currentProcess; },
              set currentProcess(p) { job.currentProcess = p; }
            };

            if (!hasSpeed) {
              job.stage = `Cutting clip ${i + 1} of ${segments.length} (⚡ God Speed)...`;
              job.progress = segBasePct;
              const cutArgs = [
                '-y',
                '-ss', String(seg.start),
                '-t', String(segDur),
                '-i', segSrc,
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                clipPath
              ];
              await runFfmpegCommand(cutArgs, subJob, segDur);
            } else {
              job.stage = `Cutting & scaling clip ${i + 1} of ${segments.length} (${segSpeed}x)...`;
              job.progress = segBasePct;

              // Step 1: Lossless slice
              const rawSlicePath = path.join(TEMP_DIR, `raw_${jobId}_${i}${segExt}`);
              job.tempFiles.add(rawSlicePath);
              rawSlicesToClean.push(rawSlicePath);

              const cutArgs = [
                '-y',
                '-ss', String(seg.start),
                '-t', String(segDur),
                '-i', segSrc,
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                rawSlicePath
              ];
              await runFfmpegCommand(cutArgs, subJob, segDur);

              // Step 2: Lossless timestamp scale + audio tempo re-encode
              let segHasAudio = true;
              try {
                const probe = await probeVideo(segSrc);
                segHasAudio = probe.hasAudio;
              } catch (e) {
                segHasAudio = true;
              }

              const speedScale = (1.0 / segSpeed).toFixed(6);
              const scaleArgs = [
                '-y',
                '-itsscale', speedScale,
                '-i', rawSlicePath,
                '-c:v', 'copy'
              ];

              if (segHasAudio) {
                const tempoFilter = buildAudioTempoFilter(segSpeed);
                scaleArgs.push(
                  '-af', `${tempoFilter},aresample=48000:async=1`,
                  ...(segExt === '.webm'
                    ? ['-c:a', 'libopus', '-b:a', '256k']
                    : ['-c:a', 'aac', '-b:a', '320k'])
                );
              }

              scaleArgs.push(clipPath);
              const scaledDur = segDur / segSpeed;
              await runFfmpegCommand(scaleArgs, subJob, scaledDur);
            }
          }

          if (job.cancelled) throw new Error('Export cancelled by user');

          const concatContent = tempClips.map(p => `file '${path.basename(p)}'`).join('\n');
          fs.writeFileSync(concatListFile, concatContent);

          job.stage = 'Joining clips losslessly at God Speed...';
          const concatArgs = [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', path.basename(concatListFile),
            '-c', 'copy'
          ];
          if (outExt === '.mp4' || outExt === '.mov') {
            concatArgs.push('-movflags', '+faststart');
          }
          concatArgs.push(finalOutPath);

          const concatSubJob = {
            set progress(pct) {
              job.progress = Math.min(99, Math.round(90 + (pct / 100) * 9));
            },
            get currentTime() { return job.currentTime; },
            set currentTime(t) { job.currentTime = t; },
            get speed() { return job.speed; },
            set speed(s) { job.speed = s; },
            get timeRemaining() { return job.timeRemaining; },
            set timeRemaining(r) { job.timeRemaining = r; },
            get stage() { return job.stage; },
            set stage(s) { job.stage = s; },
            get cancelled() { return job.cancelled; },
            get currentProcess() { return job.currentProcess; },
            set currentProcess(p) { job.currentProcess = p; }
          };

          await runFfmpegCommand(concatArgs, concatSubJob, totalCutDuration, TEMP_DIR);

        } finally {
          tempClips.forEach(p => safeUnlink(p));
          rawSlicesToClean.forEach(p => safeUnlink(p));
          safeUnlink(concatListFile);
        }
      }

      job.status = 'completed';
      job.progress = 100;
      job.stage = 'Done! ⚡ God Speed export complete.';
      job.downloadUrl = `/exports/${finalOutName}`;
      job.fullOutputPath = finalOutPath;
      job.fileName = finalOutName;
      job.completedAt = Date.now();
      return;

    } catch (losslessErr) {
      if (job.cancelled) throw losslessErr;
      console.warn(`[MONOCUT] Lossless stream copy notice, falling back to max compute encode:`, losslessErr.message);
    }
  }

  // -------------------------------------------------------------
  // MAXIMUM COMPUTE HIGH-SPEED RE-ENCODE PIPELINE
  // All CPU threads (-threads 0), ultrafast preset, VFR-to-CFR normalization
  // -------------------------------------------------------------
  job.stage = `Rendering ${segments.length} video clip(s) at maximum compute...`;

  // Compute Target Dimensions
  let targetWidth = 1920;
  let targetHeight = 1080;

  if (aspectRatio === '9:16') {
    if (resolution === '4k') {
      targetWidth = 2160; targetHeight = 3840;
    } else if (resolution === '720p') {
      targetWidth = 720; targetHeight = 1280;
    } else {
      targetWidth = 1080; targetHeight = 1920;
    }
  } else {
    // 16:9
    if (resolution === '4k') {
      targetWidth = 3840; targetHeight = 2160;
    } else if (resolution === '720p') {
      targetWidth = 1280; targetHeight = 720;
    } else if (resolution === 'source' && meta && meta.width && meta.height) {
      targetWidth = meta.width; targetHeight = meta.height;
    } else {
      targetWidth = 1920; targetHeight = 1080;
    }
  }

  // Ensure dimensions are always even numbers for all encoders (H.264 / VP9)
  targetWidth = Math.floor(targetWidth / 2) * 2;
  targetHeight = Math.floor(targetHeight / 2) * 2;

  // Determine target constant frame rate (CFR) to prevent VFR synchronization drift
  const targetFps = (aspectRatio === '9:16') ? 60 : (meta && meta.fps ? Math.round(meta.fps) : 60);
  const effectiveFps = targetFps > 0 ? targetFps : 60;

  // Build Video Filter Generator: Supports per-clip zoom, framing offset, speed re-timing, and continuous motion pan
  function buildVideoFilterForSegment(seg, idx = 0) {
    const segZoom = (seg && seg.zoomScale && seg.zoomScale > 1.05) ? seg.zoomScale : zoomScale;
    const hasSegZoom = segZoom > 1.05;
    const segCropOffset = (seg && seg.cropOffsetX !== undefined) ? seg.cropOffsetX : cropOffsetX;
    const chunkStartSeqTime = segments.slice(0, idx).reduce((sum, s) => sum + Math.max(0, (s.end - s.start) / (s.speed || 1.0)), 0);

    let vf = '';
    if (aspectRatio === '9:16') {
      if (hasMotionPan) {
        vf = `crop=ih*9/16:ih:'(in_w-ih*9/16)*(${panStart}+(${panEnd}-${panStart})*(${chunkStartSeqTime}+t)/${Math.max(1, totalCutDuration)})':0`;
      } else {
        const offset = (segCropOffset !== undefined) ? segCropOffset : panStart;
        vf = `crop=ih*9/16:ih:(in_w-ih*9/16)*${offset}:0`;
      }

      if (hasSegZoom) {
        const zw = Math.round(targetWidth * segZoom);
        const zh = Math.round(targetHeight * segZoom);
        vf += `,scale=${zw}:${zh}:flags=bicubic,crop=${targetWidth}:${targetHeight}:(iw-${targetWidth})/2:(ih-${targetHeight})/2`;
      } else {
        vf += `,scale=${targetWidth}:${targetHeight}:flags=bicubic`;
      }
    } else {
      // 16:9
      if (hasSegZoom) {
        const zw = Math.round(targetWidth * segZoom);
        const zh = Math.round(targetHeight * segZoom);
        vf = `scale=${zw}:${zh}:flags=bicubic,crop=${targetWidth}:${targetHeight}:(iw-${targetWidth})/2:(ih-${targetHeight})/2`;
      } else {
        vf = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2`;
      }
    }

    // Apply PTS re-timing if clip has customized speed
    if (seg && seg.speed && Math.abs(seg.speed - 1.0) > 0.01) {
      const speedFactor = (1 / seg.speed).toFixed(6);
      vf = `setpts=${speedFactor}*PTS,` + vf;
    }

    // VFR-to-CFR & Stream Normalization: lock SAR=1, exact target CFR, and YUV420p format
    vf += `,setsar=1,fps=${effectiveFps},format=yuv420p`;
    return vf;
  }

  const defaultVideoFilter = buildVideoFilterForSegment(segments[0], 0);

  function buildAudioFilterForSegment(seg) {
    const baseAudioFilter = 'aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo';
    if (!seg || !seg.speed || Math.abs(seg.speed - 1.0) <= 0.01) {
      return baseAudioFilter;
    }
    const tempoFilter = buildAudioTempoFilter(seg.speed);
    return `${tempoFilter},${baseAudioFilter}`;
  }

  // Audio Timestamp Alignment & Resampling Filter for native audio
  const audioFilter = 'aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo';

  // Determine Encoding Parameters (Hardware Auto-Detection, Software Fast Multithreading, Clean Upload Flags)
  const isVp9 = (outExt === '.webm');
  let videoCodecArgs = [];

  if (isVp9) {
    // High-Speed Realtime VP9 CRF Mode: -deadline realtime, -cpu-used 8, -row-mt 1 for fast CPU multithreading
    videoCodecArgs = [
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', '22',
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-row-mt', '1',
      '-tile-columns', '4',
      '-frame-parallel', '1',
      '-threads', '0'
    ];
  } else {
    // H.264: Route through NVENC, QSV, AMF, or software fallback libx264
    const hwEnc = getH264Encoder();
    if (hwEnc === 'h264_nvenc') {
      videoCodecArgs = [
        '-c:v', 'h264_nvenc',
        '-preset', 'p2',
        '-rc', 'vbr',
        '-cq', '19',
        '-pix_fmt', 'yuv420p'
      ];
    } else if (hwEnc === 'h264_qsv') {
      videoCodecArgs = [
        '-c:v', 'h264_qsv',
        '-preset', 'fast',
        '-global_quality', '20',
        '-pix_fmt', 'yuv420p'
      ];
    } else if (hwEnc === 'h264_amf') {
      videoCodecArgs = [
        '-c:v', 'h264_amf',
        '-quality', 'speed',
        '-rc', 'cqp',
        '-qp_i', '19',
        '-qp_p', '19',
        '-pix_fmt', 'yuv420p'
      ];
    } else {
      // Software libx264 without -tune fastdecode so CABAC & in-loop deblocking stay enabled
      videoCodecArgs = [
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-threads', '0',
        '-crf', '18',
        '-pix_fmt', 'yuv420p'
      ];
    }
  }

  // Audio Codec Args (Studio-quality high bitrate)
  const audioCodecArgs = isVp9
    ? ['-c:a', 'libopus', '-b:a', '256k', '-ar', '48000']
    : ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'];

  if (segments.length === 1 && !hasMultipleSources) {
    const seg = segments[0];
    let segSrc = seg.sourcePath || sourcePath;
    if (!fs.existsSync(segSrc)) {
      const found = findFileOnSystem(path.basename(segSrc));
      if (found) segSrc = found;
    }
    const segSpeed = (seg && seg.speed && seg.speed > 0.04) ? seg.speed : 1.0;
    const rawSegDur = Math.max(0.05, seg.end - seg.start);
    const segDur = rawSegDur / segSpeed;

    job.stage = `Encoding final video (${mode === 'shorts-60fps' ? 'YouTube Shorts 60fps' : 'Parallel compute'})${segSpeed !== 1.0 ? ` [${segSpeed}x Speed]` : ''}...`;

    const args = ['-y'];
    const hwaccel = getHwaccel();
    if (hwaccel) {
      args.push('-hwaccel', hwaccel);
    }
    args.push(
      '-ss', String(seg.start),
      '-t', String(rawSegDur),
      '-i', segSrc,
      '-avoid_negative_ts', 'make_zero'
    );

    let segHasAudio = true;
    try {
      const probe = await probeVideo(segSrc);
      segHasAudio = probe.hasAudio;
    } catch (e) {
      segHasAudio = true;
    }
    const isMuted = Boolean(seg.muted);
    const includeAudio = segHasAudio && !isMuted;

    if (!includeAudio) {
      args.push('-f', 'lavfi', '-t', String(segDur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }

    const segVideoFilter = buildVideoFilterForSegment(seg, 0);
    if (segVideoFilter) args.push('-vf', segVideoFilter);
    const segAudioFilter = buildAudioFilterForSegment(seg);
    if (includeAudio && segAudioFilter && !audioCodecArgs.includes('copy')) args.push('-af', segAudioFilter);
    args.push('-t', String(segDur));
    args.push(...videoCodecArgs);
    args.push(...audioCodecArgs);
    if (!includeAudio) {
      args.push('-shortest');
    }
    if (outExt === '.mp4' || outExt === '.mov') {
      args.push('-movflags', '+faststart');
    }
    args.push(finalOutPath);

    await runFfmpegCommand(args, job, segDur);

  } else {
    // Multi-segment parallel re-encode pipeline across 1 or more source files
    const tempClips = new Array(segments.length);
    const concatListFile = path.join(TEMP_DIR, `concat_${jobId}.txt`);
    job.tempFiles.add(concatListFile);
    const tempExt = outExt;

    const MAX_CHUNK_CONCURRENCY = Math.max(1, Math.min(2, os.cpus().length));
    const chunkProgress = new Array(segments.length).fill(0);

    try {
      let nextChunkIdx = 0;
      async function chunkWorker() {
        while (nextChunkIdx < segments.length) {
          if (job.cancelled) throw new Error('Export cancelled by user');
          const i = nextChunkIdx++;
          const seg = segments[i];
          let segSrc = seg.sourcePath || sourcePath;
          if (!fs.existsSync(segSrc)) {
            const found = findFileOnSystem(path.basename(segSrc));
            if (found) segSrc = found;
          }
          const clipOutPath = path.join(TEMP_DIR, `chunk_${jobId}_${i}${tempExt}`);
          tempClips[i] = clipOutPath;
          job.tempFiles.add(clipOutPath);

          const segSpeed = (seg && seg.speed && seg.speed > 0.04) ? seg.speed : 1.0;
          const rawSegDur = Math.max(0.05, seg.end - seg.start);
          const segDur = rawSegDur / segSpeed;
          job.stage = `Rendering clip ${i + 1} of ${segments.length} (${path.basename(segSrc)})${segSpeed !== 1.0 ? ` [${segSpeed}x Speed]` : ''}...`;

          // Check if segment has audio track and whether clip is muted
          let segHasAudio = true;
          try {
            const segProbe = await probeVideo(segSrc);
            segHasAudio = segProbe.hasAudio;
          } catch (e) {
            segHasAudio = true;
          }
          const isMuted = Boolean(seg.muted);
          const includeAudio = segHasAudio && !isMuted;

          const chunkArgs = ['-y'];
          const hwaccel = getHwaccel();
          if (hwaccel) {
            chunkArgs.push('-hwaccel', hwaccel);
          }
          chunkArgs.push(
            '-ss', String(seg.start),
            '-t', String(rawSegDur),
            '-i', segSrc,
            '-avoid_negative_ts', 'make_zero'
          );

          if (!includeAudio) {
            chunkArgs.push('-f', 'lavfi', '-t', String(segDur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
          }

          const segFilter = buildVideoFilterForSegment(seg, i);
          if (segFilter) chunkArgs.push('-vf', segFilter);
          const segAudioFilter = buildAudioFilterForSegment(seg);
          if (includeAudio && segAudioFilter && !audioCodecArgs.includes('copy')) {
            chunkArgs.push('-af', segAudioFilter);
          }
          chunkArgs.push('-t', String(segDur));
          chunkArgs.push(...videoCodecArgs);
          chunkArgs.push(...audioCodecArgs);
          if (!includeAudio) {
            chunkArgs.push('-shortest');
          }
          chunkArgs.push(clipOutPath);

          const subJob = {
            set progress(pct) {
              chunkProgress[i] = pct;
              const avgPct = chunkProgress.reduce((sum, val) => sum + val, 0) / segments.length;
              job.progress = Math.min(88, Math.round((avgPct / 100) * 88));
            },
            get currentTime() { return job.currentTime; },
            set currentTime(t) { job.currentTime = t; },
            get speed() { return job.speed; },
            set speed(s) { job.speed = s; },
            get timeRemaining() { return job.timeRemaining; },
            set timeRemaining(r) { job.timeRemaining = r; },
            get stage() { return job.stage; },
            set stage(s) { job.stage = s; },
            get cancelled() { return job.cancelled; },
            get currentProcess() { return job.currentProcess; },
            set currentProcess(p) {
              job.currentProcess = p;
              if (p && job.activeProcesses) {
                job.activeProcesses.add(p);
              }
            }
          };

          await runFfmpegCommand(chunkArgs, subJob, segDur);
          chunkProgress[i] = 100;
          const avgPct = chunkProgress.reduce((sum, val) => sum + val, 0) / segments.length;
          job.progress = Math.min(88, Math.round((avgPct / 100) * 88));
        }
      }

      const numWorkers = Math.min(MAX_CHUNK_CONCURRENCY, segments.length);
      const workers = [];
      for (let w = 0; w < numWorkers; w++) {
        workers.push(chunkWorker());
      }
      await Promise.all(workers);

      if (job.cancelled) throw new Error('Export cancelled by user');

      job.stage = 'Joining all video clips...';
      job.progress = 88;
      const validClips = tempClips.filter(Boolean);
      const concatContent = validClips.map(p => `file '${path.basename(p)}'`).join('\n');
      fs.writeFileSync(concatListFile, concatContent);

      const concatArgs = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', path.basename(concatListFile),
        '-c', 'copy'
      ];
      if (outExt === '.mp4' || outExt === '.mov') {
        concatArgs.push('-movflags', '+faststart');
      }
      concatArgs.push(finalOutPath);

      const concatSubJob = {
        set progress(pct) {
          job.progress = Math.min(99, Math.round(88 + (pct / 100) * 11));
        },
        get currentTime() { return job.currentTime; },
        set currentTime(t) { job.currentTime = t; },
        get speed() { return job.speed; },
        set speed(s) { job.speed = s; },
        get timeRemaining() { return job.timeRemaining; },
        set timeRemaining(r) { job.timeRemaining = r; },
        get stage() { return job.stage; },
        set stage(s) { job.stage = s; },
        get cancelled() { return job.cancelled; },
        get currentProcess() { return job.currentProcess; },
        set currentProcess(p) {
          job.currentProcess = p;
          if (p && job.activeProcesses) {
            job.activeProcesses.add(p);
          }
        }
      };

      await runFfmpegCommand(concatArgs, concatSubJob, totalCutDuration, TEMP_DIR);

    } finally {
      tempClips.forEach(p => safeUnlink(p));
      safeUnlink(concatListFile);
    }
  }

  job.status = 'completed';
  job.progress = 100;
  job.stage = 'Done! Video export complete.';
  job.downloadUrl = `/exports/${finalOutName}`;
  job.fullOutputPath = finalOutPath;
  job.fileName = finalOutName;
  job.completedAt = Date.now();
}

/**
 * Deterministic FFmpeg Executor via -progress pipe:1
 */
function runFfmpegCommand(args, job, expectedDuration, cwd = process.cwd()) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) {
      return reject(new Error('Export was cancelled by user'));
    }

    const fullArgs = [...args];
    if (!fullArgs.includes('-progress')) {
      fullArgs.push('-progress', 'pipe:1', '-nostats');
    }

    const proc = spawn(FFMPEG_PATH, fullArgs, { cwd });
    if (job) {
      if (!job.activeProcesses) job.activeProcesses = new Set();
      job.activeProcesses.add(proc);
      job.currentProcess = proc;
    }

    let stderrBuffer = '';
    let stdoutRemainder = '';

    proc.stdout.on('data', data => {
      stdoutRemainder += data.toString();
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop(); // Keep trailing incomplete token

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();

        if (job && expectedDuration > 0) {
          if (key === 'out_time_us') {
            const timeUs = Number(val);
            if (!isNaN(timeUs) && timeUs >= 0) {
              const currentTime = timeUs / 1000000;
              const pct = Math.min(99, Math.round((currentTime / expectedDuration) * 100));
              job.progress = pct;
              job.currentTime = currentTime;
            }
          } else if (key === 'speed') {
            const speedMatch = val.match(/([\d\.]+)x/);
            if (speedMatch) {
              job.speed = `${speedMatch[1]}x`;
              const speedVal = Number(speedMatch[1]);
              if (speedVal > 0 && job.currentTime !== undefined) {
                const remainingSecs = Math.max(0, Math.round((expectedDuration - job.currentTime) / speedVal));
                job.timeRemaining = `${remainingSecs}s`;
              }
            }
          } else if (key === 'progress') {
            if (val === 'end') {
              job.progress = 100;
            }
          }
        }
      }
    });

    proc.stderr.on('data', data => {
      stderrBuffer += data.toString();
    });

    proc.on('close', code => {
      if (job) {
        if (job.activeProcesses) job.activeProcesses.delete(proc);
        if (job.currentProcess === proc) {
          job.currentProcess = null;
        }
      }
      if (job && job.cancelled) {
        return reject(new Error('Export was cancelled by user'));
      }
      if (code === 0) {
        if (job) job.progress = 100;
        resolve();
      } else {
        reject(new Error(`FFmpeg error (code ${code}): ${stderrBuffer.slice(-600)}`));
      }
    });

    proc.on('error', err => {
      if (job) {
        if (job.activeProcesses) job.activeProcesses.delete(proc);
        if (job.currentProcess === proc) {
          job.currentProcess = null;
        }
      }
      reject(err);
    });
  });
}

const server = app.listen(PORT, () => {
  console.log(`[MONOCUT] Running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[MONOCUT] Port ${PORT} is already running an active MonoCut instance.`);
    process.exit(0);
  } else {
    console.error('[MONOCUT] Server error:', err);
  }
});
