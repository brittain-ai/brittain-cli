// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:tools.js
'use strict';

// Search and navigation tools: search_files, project_outline, find_symbol,
// find_references. Pruned: search_local_docs.

const path = require('path');
const fs = require('fs');
const { findReferences, findSymbol, projectOutline } = require('./semantic-navigation');
const { resolveInside, truncate, walkDir, globToRegex } = require('./files');

async function searchFiles(args, cwd) {
  const target = resolveInside(cwd, args.path);
  const maxResults = Math.min(Math.max(Math.round(Number(args.max_results) || 100), 1), 300);
  const contextLines = Math.min(Math.max(Math.round(Number(args.context_lines) || 0), 0), 10);
  const fileGlob = args.file_pattern ? globToRegex(String(args.file_pattern)) : null;
  let matcher;
  try {
    const source = args.is_regex ? String(args.pattern) : String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(source, args.case_sensitive ? '' : 'i');
  } catch (err) {
    return `Error: invalid search expression: ${err.message}`;
  }
  const candidates = [];
  if (fs.statSync(target).isFile()) candidates.push(target);
  else walkDir(target, (filePath) => {
    const rel = path.relative(target, filePath).split(path.sep).join('/');
    if (!fileGlob || fileGlob.test(rel) || fileGlob.test(path.basename(filePath))) candidates.push(filePath);
  });
  const results = [];
  for (const filePath of candidates) {
    if (results.length >= maxResults) break;
    let lines;
    try {
      if (fs.statSync(filePath).size > 2_000_000) continue;
      lines = fs.readFileSync(filePath, 'utf8').split('\n');
    } catch { continue; }
    for (let index = 0; index < lines.length && results.length < maxResults; index++) {
      if (!matcher.test(lines[index])) continue;
      const rel = path.relative(cwd, filePath);
      if (!contextLines) results.push(`${rel}:${index + 1}: ${lines[index]}`);
      else {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(lines.length - 1, index + contextLines);
        results.push(`--- ${rel} ---\n` + lines.slice(start, end + 1).map((line, offset) => {
          const lineNo = start + offset + 1;
          return `${lineNo === index + 1 ? '>' : ' '} ${lineNo}: ${line}`;
        }).join('\n'));
      }
    }
  }
  return results.length ? truncate(results.join(contextLines ? '\n\n' : '\n')) : 'No matches found.';
}

async function projectOutlineTool(args, cwd) {
  const target = resolveInside(cwd, args.path);
  return truncate(JSON.stringify(projectOutline(fs.realpathSync(cwd), target, args), null, 2));
}

async function findSymbolTool(args, cwd) {
  if (!String(args.name || '').trim()) return 'Error: name must not be empty.';
  const target = resolveInside(cwd, args.path);
  return truncate(JSON.stringify(findSymbol(fs.realpathSync(cwd), target, args), null, 2));
}

async function findReferencesTool(args, cwd) {
  const target = resolveInside(cwd, args.path);
  try { return truncate(JSON.stringify(findReferences(fs.realpathSync(cwd), target, args), null, 2)); }
  catch (error) { return `Error: ${error.message}`; }
}

module.exports = {
  handlers: {
    search_files: searchFiles,
    project_outline: projectOutlineTool,
    find_symbol: findSymbolTool,
    find_references: findReferencesTool,
  },
};
