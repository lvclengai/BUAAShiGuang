import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SchoolSyncError, syncBuaaTimetable } from "./school.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 32 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SchoolSyncError("PAYLOAD_TOO_LARGE", "请求内容过大。", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new SchoolSyncError("BAD_JSON", "请求格式不正确。", 400));
      }
    });
    req.on("error", reject);
  });
}

const loginAttempts = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;

function rateLimitKey(req) {
  return req.socket.remoteAddress || "local";
}

function checkRateLimit(req) {
  const key = rateLimitKey(req);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (attempts.length >= MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - attempts[0])) / 1000);
    throw new SchoolSyncError(
      "RATE_LIMITED",
      `尝试次数过多，请 ${Math.max(1, Math.ceil(retryAfter / 60))} 分钟后再试。`,
      429
    );
  }
  attempts.push(now);
  loginAttempts.set(key, attempts);
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== req.headers.host) {
      throw new SchoolSyncError("FORBIDDEN_ORIGIN", "不允许跨站请求课表。", 403);
    }
  } catch (error) {
    if (error instanceof SchoolSyncError) throw error;
    throw new SchoolSyncError("FORBIDDEN_ORIGIN", "请求来源不合法。", 403);
  }
}

async function handleSchoolSync(req, res) {
  checkOrigin(req);
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, message: "请使用 POST 请求同步课表。" });
    return;
  }
  checkRateLimit(req);

  const body = await readJsonBody(req);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    throw new SchoolSyncError("MISSING_CREDENTIALS", "请填写北航统一认证账号和密码。", 400);
  }
  if (username.length > 80 || password.length > 200) {
    throw new SchoolSyncError("INVALID_INPUT", "账号或密码长度不正确。", 400);
  }

  const result = await syncBuaaTimetable({ username, password });
  sendJson(res, 200, { ok: true, ...result });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    let pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === "/api/school/health") {
      sendJson(res, 200, {
        ok: true,
        service: "shiguang-school",
        syncEnabled: true
      });
      return;
    }

    if (pathname === "/api/school/sync") {
      await handleSchoolSync(req, res);
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    // 不暴露服务端源码、隐藏目录或会话相关内容。
    const blockedFiles = new Set([
      "/server.mjs",
      "/school.mjs",
      "/package.json",
      "/start.cmd",
      "/README.md",
      "/CHANGELOG.md"
    ]);
    if (
      blockedFiles.has(pathname) ||
      pathname.split("/").some((segment) => segment.startsWith("."))
    ) {
      send(res, 404, "Not found");
      return;
    }

    const filePath = path.resolve(ROOT, `.${pathname}`);
    if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
      send(res, 403, "Forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const data = await readFile(filePath);
    send(res, 200, data, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Service-Worker-Allowed": "/"
    });
  } catch (error) {
    if (error instanceof SchoolSyncError) {
      sendJson(res, error.status || 400, {
        ok: false,
        code: error.code,
        message: error.message
      });
      return;
    }
    // 不输出请求内容或凭证，仅返回通用错误。
    console.error("请求处理失败:", error && error.name ? error.name : "UnknownError");
    sendJson(res, 500, {
      ok: false,
      code: "SERVER_ERROR",
      message: "本机服务处理请求失败，请稍后重试。"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`拾光已启动：http://${HOST}:${PORT}`);
  console.log("北航课表同步服务已启用（需要校园网或学校 VPN）。");
  console.log("按 Ctrl+C 停止服务。");
});
