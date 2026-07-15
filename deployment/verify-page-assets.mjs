#!/usr/bin/env node

import crypto from "node:crypto";

const pageUrls = process.argv.slice(2);
if (!pageUrls.length) {
  console.error("Usage: verify-page-assets.mjs <page-url> [page-url...]");
  process.exit(2);
}

function executableInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    if (/\bsrc\s*=/i.test(attributes) || !body.trim()) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    scripts.push(body);
  }
  return scripts;
}

function criticalAssetUrls(html, pageUrl) {
  const urls = new Set();
  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const stylePattern = /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = scriptPattern.exec(html))) urls.add(new URL(match[1], pageUrl).toString());
  while ((match = stylePattern.exec(html))) urls.add(new URL(match[1], pageUrl).toString());
  return [...urls];
}

async function verifyAsset(assetUrl) {
  let response = await fetch(assetUrl, { method: "HEAD", redirect: "follow" });
  if (response.status === 405 || response.status === 501) {
    response = await fetch(assetUrl, { headers: { range: "bytes=0-0" }, redirect: "follow" });
  }
  if (!response.ok) throw new Error(`asset ${assetUrl} returned HTTP ${response.status}`);
}

async function verifyPage(pageUrl) {
  const response = await fetch(pageUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`page ${pageUrl} returned HTTP ${response.status}`);

  const html = await response.text();
  const csp = response.headers.get("content-security-policy") || "";
  const inlineScripts = executableInlineScripts(html);
  const missingHashes = inlineScripts
    .map(script => `sha256-${crypto.createHash("sha256").update(script).digest("base64")}`)
    .filter(hash => !csp.includes(`'${hash}'`));

  if (inlineScripts.length && !csp) throw new Error(`page ${pageUrl} has inline scripts without a CSP header`);
  if (missingHashes.length) {
    throw new Error(`page ${pageUrl} CSP is missing inline script hashes: ${missingHashes.join(", ")}`);
  }

  const assets = criticalAssetUrls(html, response.url);
  if (!assets.length) throw new Error(`page ${pageUrl} does not reference any critical JS/CSS assets`);
  await Promise.all(assets.map(verifyAsset));

  console.log(`PASS  ${pageUrl}: assets=${assets.length} inline_scripts=${inlineScripts.length} csp=compatible`);
}

try {
  for (const pageUrl of pageUrls) await verifyPage(pageUrl);
} catch (error) {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
}
