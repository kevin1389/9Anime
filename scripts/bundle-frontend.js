import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const htmlPath = path.join(rootDir, "public", "index.html");
const logoPath = path.join(rootDir, "public", "logo.svg");
const outputPath = path.join(rootDir, "core", "index-html.js");

try {
  const html = fs.readFileSync(htmlPath, "utf8");
  const logo = fs.readFileSync(logoPath, "utf8");

  const htmlB64 = Buffer.from(html).toString("base64");
  const logoB64 = Buffer.from(logo).toString("base64");

  const content = `// Auto-generated bundle of frontend assets for Vercel and Serverless deployments
export const INDEX_HTML_B64 = "${htmlB64}";
export const LOGO_SVG_B64 = "${logoB64}";

let _html = null;
let _logo = null;

export function getIndexHtml() {
  if (!_html) _html = Buffer.from(INDEX_HTML_B64, "base64").toString("utf8");
  return _html;
}

export function getLogoSvg() {
  if (!_logo) _logo = Buffer.from(LOGO_SVG_B64, "base64").toString("utf8");
  return _logo;
}
`;

  fs.writeFileSync(outputPath, content, "utf8");
  console.log(`[build] Successfully bundled frontend assets (${html.length} bytes HTML) -> ${outputPath}`);
} catch (err) {
  console.error("[build] Failed to bundle frontend:", err);
  process.exit(1);
}
