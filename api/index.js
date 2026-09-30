import fs from "fs";
import path from "path";
import worker from "../index.js";
import { handleAnimeApi } from "../core/anime-router.js";

const PUBLIC_DIR = path.join(process.cwd(), "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

export default async function handler(req, res) {
  const pathname = req.url.split("?")[0];

  // 1. Anime streaming & user progress API endpoints
  if (
    pathname.startsWith("/api/anime/") ||
    pathname.startsWith("/api/hianime/") ||
    pathname.startsWith("/api/feedback/") ||
    pathname.startsWith("/api/user/") ||
    pathname === "/home" ||
    pathname === "/api/home"
  ) {
    return handleAnimeApi(req, res);
  }

  // 2. Direct provider scraper API endpoints (watch, episodes, stream, map, api docs)
  if (
    pathname.startsWith("/watch/") ||
    pathname.startsWith("/episodes/") ||
    pathname.startsWith("/stream/") ||
    pathname.startsWith("/map/") ||
    pathname === "/api/docs" ||
    pathname === "/api/raw"
  ) {
    const host = req.headers["host"] ?? "localhost";
    const url = `https://${host}${req.url}`;

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;

    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: body?.length ? body : undefined,
      duplex: "half",
    });

    const response = await worker.fetch(request, {});

    res.statusCode = response.status;
    for (const [k, v] of response.headers) res.setHeader(k, v);

    const buf = await response.arrayBuffer();
    return res.end(Buffer.from(buf));
  }

  // 3. Static assets from public folder (e.g. /logo.svg, /assets/...)
  const sanitizedPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  if (sanitizedPath !== "/" && sanitizedPath !== "") {
    const targetFile = path.join(PUBLIC_DIR, sanitizedPath);
    if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      return res.end(fs.readFileSync(targetFile));
    }
  }

  // 4. Default frontend SPA: Always serve 99Anime streaming web app
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(fs.readFileSync(indexPath));
  }

  // 5. Fallback if index.html is missing
  res.statusCode = 404;
  res.end("Not Found");
}
