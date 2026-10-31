const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const OUT = path.join(ROOT, "output");
const DATA = path.join(ROOT, "data");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use("/output", express.static(OUT, {
  setHeaders(res) {
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

const SETTINGS = path.join(DATA, "settings.json");
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch { return {}; }
}
function getKey() { return process.env.GEMINI_API_KEY || readSettings().geminiKey || ""; }
function exec(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 30 * 60 * 1000, ...options
  });
}
function getYouTubeId(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.split("/").filter(Boolean)[0] || null;
    if (["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(host)) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const p = u.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(p[0])) return p[1] || null;
    }
  } catch {}
  return null;
}
function isPrivateHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" ||
    h === "::1" || h.startsWith("10.") || h.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "0.0.0.0";
}
async function downloadAuthorizedSource(rawUrl, dest) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("Enter a valid video URL."); }
  if (!["http:", "https:"].includes(url.protocol) || isPrivateHost(url.hostname)) {
    throw new Error("The source must be a public HTTP or HTTPS video URL.");
  }

  // Some legitimate hosting services (including download.php endpoints) send
  // the media as an attachment or application/octet-stream instead of video/mp4.
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ShortsForge/1.0)",
      "Accept": "video/*, application/octet-stream, application/download, */*;q=0.8"
    },
    signal: AbortSignal.timeout(15 * 60 * 1000)
  });
  if (!response.ok) throw new Error(`Could not retrieve source video (${response.status}). The download link may have expired or require browser access.`);

  const finalUrl = new URL(response.url);
  if (!["http:", "https:"].includes(finalUrl.protocol) || isPrivateHost(finalUrl.hostname)) {
    await response.body?.cancel();
    throw new Error("The redirected video source is not allowed.");
  }

  const type = (response.headers.get("content-type") || "").toLowerCase();
  const disposition = (response.headers.get("content-disposition") || "").toLowerCase();
  const pathName = finalUrl.pathname.toLowerCase();
  const downloadEndpoint = /\/(download|file|fetch)(\.php)?$/i.test(pathName) || pathName.endsWith(".php");
  const looksLikeVideo = type.startsWith("video/") ||
    type.includes("octet-stream") || type.includes("application/download") ||
    type.includes("application/x-download") || disposition.includes("attachment") ||
    downloadEndpoint;
  if (!looksLikeVideo) {
    await response.body?.cancel();
    throw new Error("This link did not return a recognizable video download. Use a direct MP4 link or a download link that returns the video file.");
  }

  const maxBytes = 2 * 1024 * 1024 * 1024;
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("Video exceeds the 2 GB server limit.");
  }
  if (!response.body) throw new Error("The video server returned an empty response.");

  const file = fs.createWriteStream(dest);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error("Video exceeds the 2 GB server limit.");
      if (!file.write(chunk)) await new Promise((resolve, reject) => {
        file.once("drain", resolve);
        file.once("error", reject);
      });
    }
    await new Promise((resolve, reject) => {
      file.once("error", reject);
      file.end(resolve);
    });
  } catch (err) {
    file.destroy();
    fs.unlink(dest, () => {});
    throw err;
  }
  if (!total) throw new Error("The video source was empty.");
}

function parseGeminiText(data) {
  if (data.output_text) return data.output_text;
  const result = [];
  for (const step of data.steps || []) {
    for (const c of step.content || []) if (c.text) result.push(c.text);
  }
  return result.join("\n");
}

app.get("/api/status", (req, res) => res.json({
  geminiConfigured: Boolean(getKey()),
  renderer: "FFmpeg",
  sourcePolicy: "Authorized direct video URLs and attachment/download endpoints"
}));

app.post("/api/settings", (req, res) => {
  const key = String(req.body?.geminiKey || "").trim();
  if (key && (key.length < 15 || key.length > 500)) {
    return res.status(400).json({ error: "That Gemini API key does not look valid." });
  }
  const current = readSettings();
  if (key) current.geminiKey = key;
  fs.writeFileSync(SETTINGS, JSON.stringify(current, null, 2), { mode: 0o600 });
  res.json({ ok: true, geminiConfigured: Boolean(getKey()) });
});

app.post("/api/analyze-youtube", async (req, res) => {
  try {
    const id = getYouTubeId(String(req.body?.youtubeUrl || ""));
    if (!id || !/^[\w-]{6,20}$/.test(id)) {
      return res.status(400).json({ error: "Enter a valid public YouTube video URL." });
    }
    if (!getKey()) return res.status(400).json({ error: "Add your Gemini API key in Settings first." });

    const prompt = `Analyze this public YouTube video and suggest up to 5 compelling short-form clips.
Return ONLY valid JSON in this exact shape:
{"clips":[{"title":"short title","start":12,"end":48,"hook":"opening hook","caption":"short caption","reason":"why this moment works"}]}
Use seconds for start and end. Each clip should be 20 to 60 seconds. Do not invent timestamps outside the video.`;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": getKey() },
      body: JSON.stringify({
        model: "gemini-3.8-flash",
        input: [
          { type: "video", uri: `https://www.youtube.com/watch?v=${id}` },
          { type: "text", text: prompt }
        ]
      })
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error("Gemini returned an unreadable response."); }
    if (!response.ok) throw new Error(data.error?.message || `Gemini error ${response.status}`);
    const text = parseGeminiText(data);
    const clean = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    let parsed;
    try { parsed = JSON.parse(clean); } catch { throw new Error("Gemini did not return valid clip suggestions."); }
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || "Analysis failed." });
  }
});

app.post("/api/render", async (req, res) => {
  const id = crypto.randomBytes(8).toString("hex");
  const source = path.join(OUT, `${id}-source.mp4`);
  const output = path.join(OUT, `${id}-short.mp4`);
  try {
    const videoUrl = String(req.body?.videoUrl || "").trim();
    const start = Number(req.body?.start);
    const end = Number(req.body?.end);
    const caption = String(req.body?.caption || "").trim().slice(0, 220);
    if (!videoUrl) return res.status(400).json({ error: "Paste a direct video URL or a download link." });
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 180) {
      return res.status(400).json({ error: "Choose a valid clip between 1 and 180 seconds." });
    }

    await downloadAuthorizedSource(videoUrl, source);

    const filters = [
      "scale=1080:1920:force_original_aspect_ratio=increase",
      "crop=1080:1920",
      "setsar=1",
      "fps=30"
    ];
    if (caption) {
      const escaped = caption.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%");
      filters.push(`drawtext=text='${escaped}':fontcolor=white:fontsize=54:borderw=3:bordercolor=black:shadowcolor=black:shadowx=2:shadowy=2:x=(w-text_w)/2:y=h*0.78`);
    }

    await exec(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y", "-ss", String(start), "-i", source,
      "-t", String(end - start),
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart", "-pix_fmt", "yuv420p",
      output
    ]);
    fs.unlink(source, () => {});
    res.json({ ok: true, file: `/output/${id}-short.mp4`, filename: "ShortsForge-clip.mp4" });
  } catch (e) {
    fs.unlink(source, () => {});
    fs.unlink(output, () => {});
    res.status(500).json({ error: e.message || "Video rendering failed. Check that FFmpeg is installed." });
  }
});

app.listen(PORT, () => console.log(`ShortsForge running on port ${PORT}`));
