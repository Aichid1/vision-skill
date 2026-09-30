#!/usr/bin/env node
/**
 * 独立识图脚本 — 调用千问 VL 模型，按量付费。
 *
 * 用法:
 *   node vision.js <图片路径> [问题]
 *   node vision.js --url <图片链接> [问题]
 *
 * 图片自动压缩（防止大图导致 token 爆量 / 请求失败）:
 *   最长边超过 VISION_MAX_DIM(默认 2048px)，或体积超过 VISION_MAX_BYTES(默认 4MB) 时，
 *   自动缩放并转成 JPEG(VISION_QUALITY，默认 85) 后再发送。
 *   压缩优先使用 sharp（自动探测运行时内置版本），找不到时在 Windows 上回退 PowerShell System.Drawing。
 *   可通过 VISION_RESIZE=off 关闭自动压缩。
 *   压缩产物仅在内存/临时目录中使用，不会覆盖原图；识别完成后自动清除。
 *
 * 依赖:
 *   npm install dotenv (可选，如果有 .env 文件)
 *   sharp (可选，用于图片压缩)
 *   DASHSCOPE_API_KEY 环境变量 或 同目录 .env 文件
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

// 尝试加载 .env（先找当前目录，再找脚本所在目录）；.env 中的值优先于继承的环境变量
try { require("dotenv").config({ override: true }); } catch {}
try { require("dotenv").config({ path: path.resolve(__dirname, ".env"), override: true }); } catch {}

// Fallback loader so a local .env works even when the dotenv package is not installed
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      let key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+#.*$/, "");
      }
      process.env[key] = val; // .env 优先于继承的环境变量
    }
  } catch {}
}
loadEnvFile(path.resolve(__dirname, ".env"));
const BASE_URL = process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
const API_KEY = process.env.DASHSCOPE_API_KEY || "sk-xxx";
const MODEL = process.env.VISION_MODEL || "qwen3.7-plus";

// ---- 图片大小限制（可用环境变量覆盖）----
const MAX_DIM = Math.max(512, parseInt(process.env.VISION_MAX_DIM, 10) || 2048);              // 最长边上限(px)
const MAX_BYTES = Math.max(64 * 1024, parseInt(process.env.VISION_MAX_BYTES, 10) || (4 * 1024 * 1024)); // 体积上限(Byte)
const JPEG_QUALITY = Math.min(95, Math.max(40, parseInt(process.env.VISION_QUALITY, 10) || 85));
const RESIZE_ENABLED = process.env.VISION_RESIZE !== "off";
const PAYLOAD_LIMIT = 10 * 1024 * 1024; // 单张图片 base64 后上限(Byte)，超过直接报错

// 跟踪已创建的临时目录，识别结束或进程退出时统一清理（压缩产物不落盘、不覆盖原图）
const tempDirs = [];
process.on("exit", () => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + "MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + "KB";
  return n + "B";
}

// 自动探测 sharp：当前目录 -> VISION_SHARP_PATH -> 运行 Node 同级的 node_modules
function loadSharp() {
  const candidates = [];
  try { candidates.push(require.resolve("sharp")); } catch {}
  if (process.env.VISION_SHARP_PATH) candidates.push(process.env.VISION_SHARP_PATH);
  if (process.execPath) {
    candidates.push(path.resolve(path.dirname(process.execPath), "..", "node_modules", "sharp"));
    candidates.push(path.resolve(path.dirname(process.execPath), "node_modules", "sharp"));
  }
  for (const c of candidates) {
    try { return require(c); } catch {}
  }
  return null;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let imageSource = "", prompt = "", isUrl = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      isUrl = true;
      imageSource = argv[++i];
    } else if (!imageSource && !argv[i].startsWith("--")) {
      imageSource = argv[i];
    } else if (imageSource && !argv[i].startsWith("--")) {
      prompt = prompt ? prompt + " " + argv[i] : argv[i];
    }
  }
  if (!prompt) prompt = "请详细描述这张图片的内容。";
  return { imageSource, prompt, isUrl };
}

function resolveImageSource(source, isUrl) {
  const label = isUrl ? source : path.resolve(source);
  if (isUrl) return { filePath: null, buf: null, mime: null, label };
  if (!fs.existsSync(label)) throw new Error(`文件不存在: ${label}`);
  const ext = path.extname(label).toLowerCase().replace(".", "");
  const mimeMap = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };
  return { filePath: label, buf: null, mime: `image/${mimeMap[ext] || "jpeg"}`, label };
}

// 下载网络图片（支持重定向，超过限制直接失败）
function downloadImage(url, maxBytes, redirects) {
  redirects = redirects || 0;
  if (redirects > 3) return Promise.reject(new Error("下载重定向次数过多"));
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const req = transport.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(downloadImage(new URL(res.headers.location, url).toString(), maxBytes, redirects + 1));
        return;
      }
      if (res.statusCode >= 400) {
        res.resume();
        reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        return;
      }
      const declared = res.headers["content-length"] ? parseInt(res.headers["content-length"], 10) : 0;
      if (declared > maxBytes) {
        res.resume();
        reject(new Error(`图片超过下载限制 ${fmtSize(maxBytes)}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error(`图片超过下载限制 ${fmtSize(maxBytes)}`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function resizeWithSharp(sharp, src) {
  const opts = { width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true };
  try {
    return await sharp(src).rotate().resize(opts).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  } catch (e) {
    return await sharp(src).resize(opts).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  }
}

// PowerShell System.Drawing 压缩脚本（Windows 上 sharp 不可用时的回退）
const PS_RESIZE_SCRIPT = [
  "param($src, $dst, $maxDim, $quality)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$img = $null; $bmp = $null; $g = $null",
  "try {",
  "  $img = [System.Drawing.Image]::FromFile($src)",
  "  $scale = [Math]::Min(1.0, [double]$maxDim / [Math]::Max($img.Width, $img.Height))",
  "  $w = [Math]::Max(1, [int][Math]::Round($img.Width * $scale))",
  "  $h = [Math]::Max(1, [int][Math]::Round($img.Height * $scale))",
  "  $bmp = New-Object System.Drawing.Bitmap($w, $h)",
  "  $g = [System.Drawing.Graphics]::FromImage($bmp)",
  "  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality",
  "  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
  "  $g.DrawImage($img, 0, 0, $w, $h)",
  "  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }",
  "  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)",
  "  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)",
  "  $bmp.Save($dst, $codec, $ep)",
  "  Write-Output ($w.ToString() + 'x' + $h.ToString())",
  "} finally {",
  "  if ($g) { $g.Dispose() }",
  "  if ($bmp) { $bmp.Dispose() }",
  "  if ($img) { $img.Dispose() }",
  "}",
].join("\r\n");

function runPowershell(scriptFile, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, ...args], { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `PowerShell 退出码 ${code}`));
    });
  });
}

async function tryPowerShellResize(src) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-"));
  tempDirs.push(tmpDir);
  const srcFile = path.join(tmpDir, "input.img");
  const dstFile = path.join(tmpDir, "out.jpg");
  const psFile = path.join(tmpDir, "resize.ps1");
  try {
    if (!src.filePath) fs.writeFileSync(srcFile, src.buf);
    const inputPath = src.filePath || srcFile;
    fs.writeFileSync(psFile, PS_RESIZE_SCRIPT);
    await runPowershell(psFile, [inputPath, dstFile, String(MAX_DIM), String(JPEG_QUALITY)]);
    const buf = fs.readFileSync(dstFile);
    console.error(`[vision] ${src.label}: 已用 PowerShell 压缩 (${fmtSize(fs.statSync(inputPath).size)} -> ${fmtSize(buf.length)})`);
    return buf;
  } catch (e) {
    throw new Error(`图片过大（${src.label}）且自动压缩失败: ${e.message}。请将图片最长边缩到 ${MAX_DIM}px 以内或压缩到 ${fmtSize(MAX_BYTES)} 以内后重试。`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const idx = tempDirs.indexOf(tmpDir);
    if (idx >= 0) tempDirs.splice(idx, 1);
  }
}

// 预处理：超限自动缩放/压缩，返回可直接发送的 data URL
async function prepareImage(src) {
  const sharp = loadSharp();
  let meta = null;
  if (sharp) {
    try {
      meta = await (src.filePath ? sharp(src.filePath) : sharp(src.buf)).metadata();
    } catch {}
  }
  const sizeBytes = src.buf ? src.buf.length : (src.filePath ? fs.statSync(src.filePath).size : 0);
  let mime = src.mime;
  if (!mime && meta) mime = "image/" + (meta.format === "jpg" ? "jpeg" : meta.format);
  if (!mime) mime = "image/jpeg";
  const dims = meta ? `${meta.width}x${meta.height}` : "尺寸未知";
  const needResize = RESIZE_ENABLED && (sizeBytes > MAX_BYTES || (meta && (meta.width > MAX_DIM || meta.height > MAX_DIM)));

  let dataUrl;
  if (needResize && sharp) {
    const out = await resizeWithSharp(sharp, src.filePath || src.buf);
    const outMeta = await sharp(out).metadata();
    console.error(`[vision] ${src.label}: 原图 ${dims} (${fmtSize(sizeBytes)}) -> ${outMeta.width}x${outMeta.height} JPEG (${fmtSize(out.length)})`);
    dataUrl = `data:image/jpeg;base64,${out.toString("base64")}`;
  } else if (needResize) {
    const out = await tryPowerShellResize(src);
    dataUrl = `data:image/jpeg;base64,${out.toString("base64")}`;
  } else {
    const buf = src.buf || fs.readFileSync(src.filePath);
    dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  }

  if (Buffer.byteLength(dataUrl) > PAYLOAD_LIMIT) {
    throw new Error(`图片压缩后仍超过 ${fmtSize(PAYLOAD_LIMIT)}（${src.label}），请手动缩小图片后重试。`);
  }
  return dataUrl;
}

function request(payload) {
  const url = new URL(BASE_URL.replace(/\/?$/, "/") + "chat/completions");
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`API ${res.statusCode}: ${data.slice(0, 300)}`));
        try {
          resolve(JSON.parse(data)?.choices?.[0]?.message?.content || data);
        } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) {
    console.error("请设置 DASHSCOPE_API_KEY 环境变量或在 .env 文件中配置。");
    console.error("获取 Key: https://bailian.console.aliyun.com/");
    process.exit(1);
  }
  const { imageSource, prompt, isUrl } = parseArgs();
  if (!imageSource) {
    console.error("用法: node vision.js <图片路径> [问题]");
    console.error("      node vision.js --url <图片链接> [问题]");
    process.exit(1);
  }
  try {
    const src = resolveImageSource(imageSource, isUrl);
    if (isUrl) {
      src.buf = await downloadImage(src.label, Math.max(MAX_BYTES, 50 * 1024 * 1024));
    }
    const imageUrl = await prepareImage(src);
    const result = await request({
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageUrl } },
        { type: "text", text: prompt },
      ]}],
      stream: false,
      max_tokens: 1024,
    });
    console.log(result);
  } catch (err) {
    console.error("识图失败:", err.message);
    process.exit(1);
  }
}

main();