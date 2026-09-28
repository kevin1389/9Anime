import "dotenv/config";
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import worker from "./index.js";
import { handleAnimeApi } from "./core/anime-router.js";
import { initHiAnimeSyncEngine } from "./core/hianime-sync.js";

const PORT  = Number(process.env.PORT) || 3000;
const BASE  = process.env.BASE_PATH ?? "";
const __dir = dirname(fileURLToPath(import.meta.url));

const STATIC = {
  "/":               { file: "public/index.html", mime: "text/html" },
  "/index.html":     { file: "public/index.html", mime: "text/html" },
  "/app":            { file: "public/index.html", mime: "text/html" },
  "/docs":           { file: "docs/index.html",   mime: "text/html" },
  "/docs/":          { file: "docs/index.html",   mime: "text/html" },
  "/api-home":       { file: "docs/landing.html", mime: "text/html" },
  "/style.css":      { file: "docs/style.css",    mime: "text/css"  },
  "/docs/style.css": { file: "docs/style.css",    mime: "text/css"  },
  "/logo.svg":       { file: "docs/logo.svg",     mime: "image/svg+xml" },
  "/docs/logo.svg":  { file: "docs/logo.svg",     mime: "image/svg+xml" },
};

function serveStatic(req, res, entry) {
  try {
    const body = readFileSync(join(__dir, entry.file));
    res.writeHead(200, {
      "Content-Type":  entry.mime + "; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": Buffer.byteLength(body),
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(body);
    }
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function nodeToRequest(req) {
  const host     = req.headers["host"] ?? `localhost:${PORT}`;
  const stripped = BASE && req.url.startsWith(BASE) ? req.url.slice(BASE.length) || "/" : req.url;
  const url      = `http://${host}${stripped}`;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : null;

  return new Request(url, {
    method:  req.method,
    headers: req.headers,
    body:    body?.length ? body : undefined,
    duplex:  "half",
  });
}

const server = http.createServer(async (req, res) => {
  console.log(`→ ${req.method} ${req.url}`);

  const pathname = req.url.split("?")[0];
  const staticEntry = STATIC[pathname] || STATIC[pathname.replace(/\/+$/, "")] || STATIC[pathname + "/"];

  if ((req.method === "GET" || req.method === "HEAD") && staticEntry) {
    return serveStatic(req, res, staticEntry);
  }

  // Handle Anime Frontend, HiAnime API, and Feedback routes
  if (
    pathname.startsWith("/api/anime/") ||
    pathname.startsWith("/api/hianime/") ||
    pathname.startsWith("/api/feedback/") ||
    pathname === "/home" ||
    pathname === "/api/home"
  ) {
    return handleAnimeApi(req, res);
  }

  try {
    const request  = await nodeToRequest(req);
    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Unhandled error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AniMoon dev server → http://0.0.0.0:${PORT}`);
  initHiAnimeSyncEngine();
});
