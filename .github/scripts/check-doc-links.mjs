#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const markdown = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && [".md", ".markdown"].includes(extname(entry.name))) markdown.push(path);
  }
}

function targets(content) {
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) links.push(match[1].trim());
  return links;
}

await walk(root);
const errors = [];
for (const file of markdown) {
  const content = await readFile(file, "utf8");
  for (const target of targets(content)) {
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const clean = target.split("#", 1)[0].split("?", 1)[0].replace(/^<|>$/g, "");
    if (!clean) continue;
    const destination = resolve(dirname(file), clean);
    try {
      await stat(destination);
    } catch {
      errors.push(`${file.replace(`${root}/`, "")}: broken link ${target}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation link check passed (${markdown.length} Markdown files).`);
}
