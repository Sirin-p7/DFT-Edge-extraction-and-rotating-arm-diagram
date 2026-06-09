import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const requestedPort = Number(process.argv.find((arg) => /^\d+$/.test(arg)) || 5174);
const shouldOpen = process.argv.includes("--open");
const channelArgIndex = process.argv.indexOf("--channel");
const startupChannel = channelArgIndex >= 0 ? process.argv[channelArgIndex + 1] : "api";
const viewerProfiles = {
  api: {
    name: "api",
    title: "API Line-Art Fourier Viewer",
    resultRoot: "results_api",
    defaultChannel: "API_Line",
    channels: [{ value: "API_Line", label: "API line art" }]
  },
  normal: {
    name: "normal",
    title: "Normal XDoG Fourier Viewer",
    resultRoot: "results_v2",
    defaultChannel: "XDoG_Guide",
    channels: [
      { value: "XDoG_Guide", label: "XDoG guide" },
      { value: "XDoG_Support", label: "XDoG support" }
    ]
  }
};
const viewerProfile = viewerProfiles[startupChannel] || viewerProfiles.api;
const tasks = new Map();
let nextTaskId = 1;
const precomputeModes = new Set(["sequential", "simultaneous", "full_svg", "both", "all"]);
const globalSceneParamKeys = ["duration", "hold", "target_fps", "draw_stride"];
const modeSceneParamKeys = {
  sequential: [
    "samples", "arms", "min_loop_samples", "min_loop_length", "max_loop_length",
    "smooth_passes", "duration", "hold", "target_fps", "draw_stride",
    "component_time_power", "coefficient_order"
  ],
  simultaneous: [
    "samples", "arms", "min_loop_samples", "min_loop_length", "max_loop_length",
    "smooth_passes", "duration", "hold", "target_fps", "draw_stride",
    "component_time_power", "sim_arm_parts", "coefficient_order"
  ],
  full_svg: [
    "samples", "arms", "min_loop_samples", "min_loop_length", "max_loop_length",
    "smooth_passes", "duration", "hold", "target_fps", "draw_stride",
    "order", "coefficient_order"
  ]
};
const sceneParamKeys = new Set([
  ...globalSceneParamKeys,
  ...Object.entries(modeSceneParamKeys).flatMap(([mode, keys]) => keys.map((key) => `${mode}.${key}`))
]);

const types = {
  ".bmp": "image/bmp",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webm": "video/webm"
};

function send(response, status, text) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function safeName(value) {
  return /^[A-Za-z0-9_-]+$/.test(value || "") ? value : "";
}

function safeStem(value) {
  return String(value || "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "upload";
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function findToolExe() {
  const candidates = [
    join(root, "Fourier-api-approach.exe"),
    join(root, "Fourier-api-approach", "x64", "Release", "Fourier-api-approach.exe"),
    join(root, "x64", "Release", "Fourier-api-approach.exe")
  ];
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

function findProjectFourierExe() {
  const candidates = [
    join(root, "ProjectFourier.exe"),
    join(root, "x64", "Release", "ProjectFourier.exe"),
    join(root, "ProjectFourier", "x64", "Release", "ProjectFourier.exe")
  ];
  return candidates.find((path) => existsSync(path)) || candidates[0];
}

function childProcessEnv() {
  const env = { ...process.env };
  const opencvDir = env.OPENCV_DIR;
  const pathParts = [];
  if (opencvDir) {
    const dllDir = join(opencvDir, "x64", "vc16", "bin");
    pathParts.push(dllDir);
  }
  const potraceDirs = [
    root,
    env.POTRACE_DIR,
    join(env.USERPROFILE || "", "Documents", "POTRACE", "potrace-1.16.win64")
  ].filter(Boolean);
  for (const dir of potraceDirs) {
    if (existsSync(join(dir, "potrace.exe"))) pathParts.push(dir);
  }
  if (pathParts.length) env.PATH = `${pathParts.join(";")};${env.PATH || ""}`;
  return env;
}

function sanitizeSceneParamValue(key, value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";

  if (key.endsWith(".order") || key === "order") {
    return text === "component" || text === "nearest" ? text : "";
  }
  if (key.endsWith(".coefficient_order") || key === "coefficient_order") {
    return text === "amplitude" || text === "frequency" ? text : "";
  }

  const number = Number(text);
  return Number.isFinite(number) ? String(number) : "";
}

function writeSceneConfigOverride(params) {
  if (!params || typeof params !== "object") return "";

  const lines = [];
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = String(rawKey || "").trim();
    if (!sceneParamKeys.has(key)) continue;
    const value = sanitizeSceneParamValue(key, rawValue);
    if (!value) continue;
    lines.push(`${key}=${value}`);
  }
  if (lines.length === 0) return "";

  const configDir = join(root, "temp_configs");
  ensureDir(configDir);
  const configPath = join(configDir, `dft_scene_params_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
  const basePath = join(root, "dft_scene_params.txt");
  const baseConfig = existsSync(basePath) ? readFileSync(basePath, "utf8").replace(/\s*$/, "") : "";
  writeFileSync(configPath, `${baseConfig}\n\n# Web overrides\n${lines.join("\n")}\n`, "utf8");
  return configPath;
}

function collectRequestBody(request, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error("Upload is larger than 50 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", rejectBody);
  });
}

function parseMultipartUpload(request, body) {
  const contentType = request.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing multipart boundary");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = 0;
  while (true) {
    const start = body.indexOf(boundary, cursor);
    if (start < 0) break;
    const partStart = start + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    let contentStart = partStart;
    if (body[contentStart] === 13 && body[contentStart + 1] === 10) contentStart += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), contentStart);
    if (headerEnd < 0) break;
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next < 0) break;
    const headerText = body.slice(contentStart, headerEnd).toString("utf8");
    let dataEnd = next;
    if (body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) dataEnd -= 2;
    parts.push({ headerText, data: body.slice(headerEnd + 4, dataEnd) });
    cursor = next;
  }

  for (const part of parts) {
    const disposition = part.headerText.match(/content-disposition:[^\r\n]*/i)?.[0] || "";
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || "";
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || "";
    if (name === "file" && filename && part.data.length > 0) {
      return { filename, data: part.data };
    }
  }
  throw new Error("No uploaded file found");
}

function listImages() {
  const dir = normalize(resolve(join(root, viewerProfile.resultRoot)));
  if (!dir.startsWith(root) || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => safeName(name))
    .filter((name) => {
      const imageDir = join(dir, name);
      return statSync(imageDir).isDirectory() && existsSync(join(imageDir, "comp"));
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

function runTask(label, command, args) {
  const id = String(nextTaskId++);
  const task = {
    id,
    label,
    command,
    args,
    status: "running",
    code: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: ""
  };
  tasks.set(id, task);

  const child = spawn(command, args, { cwd: root, env: childProcessEnv(), windowsHide: true });
  const append = (chunk) => {
    task.log += chunk.toString();
    if (task.log.length > 120000) task.log = task.log.slice(-120000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    task.status = "failed";
    task.finishedAt = new Date().toISOString();
    append(`\n${error.message}\n`);
  });
  child.on("close", (code) => {
    task.status = code === 0 ? "completed" : "failed";
    task.code = code;
    task.finishedAt = new Date().toISOString();
  });

  return task;
}

async function handleApi(request, response, url) {
  if (url.pathname === "/api/viewer-config") {
    sendJson(response, viewerProfile);
    return true;
  }

  if (url.pathname === "/api/images") {
    sendJson(response, { images: listImages() });
    return true;
  }

  if (url.pathname === "/api/components") {
    const image = safeName(url.searchParams.get("image"));
    const channel = safeName(url.searchParams.get("channel"));
    const dir = normalize(resolve(join(root, viewerProfile.resultRoot, image, "comp")));

    if (!image || !channel || !dir.startsWith(root) || !existsSync(dir)) {
      sendJson(response, { files: [] });
      return true;
    }

    const prefix = `${channel}_`;
    const files = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".svg"))
      .sort();
    sendJson(response, { files });
    return true;
  }

  if (url.pathname === "/api/upload" && request.method === "POST") {
    try {
      const body = await collectRequestBody(request);
      const upload = parseMultipartUpload(request, body);
      const ext = extname(upload.filename).toLowerCase();
      if (![".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) {
        sendJson(response, { error: "Only PNG, JPG, JPEG, and BMP files are supported" }, 400);
        return true;
      }
      const stem = safeStem(upload.filename);
      const uploadDir = join(root, "uploads");
      ensureDir(uploadDir);
      const path = join(uploadDir, `${stem}${ext}`);
      writeFileSync(path, upload.data);
      sendJson(response, { image: stem, path: `uploads/${stem}${ext}` });
    } catch (error) {
      sendJson(response, { error: error.message }, 400);
    }
    return true;
  }

  if (url.pathname === "/api/process" && request.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(request, 1024 * 1024)).toString("utf8") || "{}");
      const input = String(body.input || "");
      const inputPath = normalize(resolve(join(root, input)));
      if (!input || !inputPath.startsWith(root) || !existsSync(inputPath)) {
        sendJson(response, { error: "Input file does not exist" }, 400);
        return true;
      }
      let command;
      let args;
      let label;
      if (viewerProfile.name === "normal") {
        command = findProjectFourierExe();
        args = ["--no-gui", inputPath];
        label = `Local extract ${safeStem(input)}`;
      } else {
        const dftConfig = writeSceneConfigOverride(body.params);
        command = findToolExe();
        args = ["--config", "api_line_config.ini", "--output", viewerProfile.resultRoot];
        if (dftConfig) args.push("--dft-config", dftConfig);
        args.push(inputPath);
        label = `API extract ${safeStem(input)}`;
      }
      const task = runTask(label, command, args);
      sendJson(response, { taskId: task.id });
    } catch (error) {
      sendJson(response, { error: error.message }, 400);
    }
    return true;
  }

  if (url.pathname === "/api/precompute" && request.method === "POST") {
    try {
      const body = JSON.parse((await collectRequestBody(request, 1024 * 1024)).toString("utf8") || "{}");
      const image = safeName(body.image);
      const mode = safeName(body.mode || "both");
      const channel = safeName(body.channel || viewerProfile.defaultChannel);
      if (!precomputeModes.has(mode)) {
        sendJson(response, { error: "Unsupported DFT mode" }, 400);
        return true;
      }
      if (!image || !existsSync(join(root, viewerProfile.resultRoot, image, "comp"))) {
        sendJson(response, { error: "Image result folder does not exist" }, 400);
        return true;
      }
      const dftConfig = writeSceneConfigOverride(body.params);
      const args = ["--precompute-only", "--config", "api_line_config.ini", "--output", viewerProfile.resultRoot, "--modes", mode];
      if (dftConfig) args.push("--dft-config", dftConfig);
      if (channel) args.push("--channels", channel);
      args.push(image);
      const task = runTask(`Precompute ${image} ${mode}`, findToolExe(), args);
      sendJson(response, { taskId: task.id });
    } catch (error) {
      sendJson(response, { error: error.message }, 400);
    }
    return true;
  }

  if (url.pathname === "/api/task") {
    const id = String(url.searchParams.get("id") || "");
    const task = tasks.get(id);
    if (!task) sendJson(response, { error: "Task not found" }, 404);
    else sendJson(response, task);
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (await handleApi(request, response, url)) return;

  const rawPath = decodeURIComponent(url.pathname);
  const relativePath = rawPath === "/" ? "dft_viewer.html" : rawPath.slice(1);
  const fullPath = normalize(resolve(join(root, relativePath)));

  if (!fullPath.startsWith(root) || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
    send(response, 404, "Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": types[extname(fullPath).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(fullPath).pipe(response);
});

function openBrowser(url) {
  if (!shouldOpen) return;
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function listen(port, attemptsLeft = 20) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
      listen(port + 1, attemptsLeft - 1);
      return;
    }

    console.error(error);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/dft_viewer.html`;
    console.log(`LLM line-art Fourier viewer: ${url}`);
    console.log(`Channel profile: ${viewerProfile.name} (${viewerProfile.resultRoot} / ${viewerProfile.defaultChannel})`);
    console.log("Keep this window open while using the viewer.");
    openBrowser(url);
  });
}

listen(Number.isFinite(requestedPort) ? requestedPort : 5174);
