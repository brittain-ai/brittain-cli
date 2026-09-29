// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/tools/semantic-navigation.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.go', '.h', '.hpp', '.java', '.js', '.jsx',
  '.mjs', '.cjs', '.py', '.rb', '.rs', '.ts', '.tsx',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.output', '.turbo', 'build', 'coverage', 'dist',
  'node_modules', 'target', 'vendor',
]);
const MAX_SOURCE_BYTES = 1_000_000;

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback;
}

function sourceFiles(target, maxFiles) {
  const files = [];
  let truncated = false;
  const visit = (entryPath) => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let stat;
    try { stat = fs.statSync(entryPath); } catch { return; }
    if (stat.isFile()) {
      if (SOURCE_EXTENSIONS.has(path.extname(entryPath).toLowerCase()) && stat.size <= MAX_SOURCE_BYTES) files.push(entryPath);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = fs.readdirSync(entryPath, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      visit(path.join(entryPath, entry.name));
    }
  };
  visit(target);
  return { files, truncated };
}

function cleanSignature(line) {
  const value = line.trim().replace(/\s+/g, ' ');
  return value.length > 240 ? value.slice(0, 237) + '...' : value;
}

function symbol(kind, name, line, lineNumber) {
  return { kind, name, line: lineNumber, signature: cleanSignature(line) };
}

function symbolsForLine(line, lineNumber, extension) {
  const results = [];
  const add = (kind, name) => {
    if (name && !results.some((item) => item.kind === kind && item.name === name)) {
      results.push(symbol(kind, name, line, lineNumber));
    }
  };
  let match;

  match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(class|interface|enum|namespace|module|trait|struct)\s+([A-Za-z_$][\w$]*)/);
  if (match) add(match[1], match[2]);

  if (extension === '.rs') {
    match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/);
    if (match) add('function', match[1]);
    match = line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:type|const|static)\s+([A-Za-z_][\w]*)/);
    if (match) add('declaration', match[1]);
  } else if (extension === '.py') {
    match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
    if (match) add('function', match[1]);
    match = line.match(/^\s*class\s+([A-Za-z_][\w]*)/);
    if (match) add('class', match[1]);
  } else if (extension === '.go') {
    match = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/);
    if (match) add('function', match[1]);
    match = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+/);
    if (match) add('type', match[1]);
    match = line.match(/^\s*(?:var|const)\s+([A-Za-z_][\w]*)/);
    if (match) add('declaration', match[1]);
  } else if (extension === '.rb') {
    match = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][\w!?=]*)/);
    if (match) add('function', match[1]);
    match = line.match(/^\s*(?:class|module)\s+([A-Za-z_][\w:]*)/);
    if (match) add('class', match[1]);
  } else {
    match = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (match) add('function', match[1]);
    match = line.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/);
    if (match) add(/=>|=\s*(?:async\s+)?function\b/.test(line) ? 'function' : 'variable', match[1]);
    match = line.match(/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match) add('type', match[1]);

    if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.java'].includes(extension)) {
      match = line.match(/^\s*(?:(?:public|private|protected|static|final|virtual|inline|extern|const|synchronized|native|abstract)\s+)*(?:[A-Za-z_$][\w$:<>,.?*&\[\]]*\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|$)/);
      if (match && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) add('function', match[1]);
    }
  }
  return results;
}

function readSymbols(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let lines;
  try { lines = fs.readFileSync(filePath, 'utf8').split('\n'); } catch { return { lines: [], symbols: [] }; }
  const symbols = [];
  for (let index = 0; index < lines.length; index += 1) {
    symbols.push(...symbolsForLine(lines[index], index + 1, extension));
  }
  return { lines, symbols };
}

function projectOutline(projectRoot, target, args = {}) {
  const maxFiles = boundedInteger(args.max_files, 100, 1, 500);
  const maxSymbols = boundedInteger(args.max_symbols, 500, 1, 2_000);
  const found = sourceFiles(target, maxFiles);
  const files = [];
  let symbolCount = 0;
  let symbolsTruncated = false;
  for (const filePath of found.files) {
    if (symbolCount >= maxSymbols) {
      symbolsTruncated = true;
      break;
    }
    const parsed = readSymbols(filePath).symbols;
    const remaining = maxSymbols - symbolCount;
    const selected = parsed.slice(0, remaining);
    if (parsed.length > selected.length) symbolsTruncated = true;
    symbolCount += selected.length;
    files.push({ path: path.relative(projectRoot, filePath).split(path.sep).join('/'), symbols: selected });
  }
  return {
    scope: path.relative(projectRoot, target).split(path.sep).join('/') || '.',
    files,
    file_count: files.length,
    symbol_count: symbolCount,
    truncated: found.truncated || symbolsTruncated,
  };
}

function findSymbol(projectRoot, target, args = {}) {
  const name = String(args.name || '');
  const maxResults = boundedInteger(args.max_results, 50, 1, 200);
  const maxFiles = boundedInteger(args.max_files, 500, 1, 2_000);
  const caseSensitive = args.case_sensitive !== false;
  const expected = caseSensitive ? name : name.toLowerCase();
  const kind = args.kind ? String(args.kind).toLowerCase() : '';
  const found = sourceFiles(target, maxFiles);
  const results = [];
  for (const filePath of found.files) {
    for (const item of readSymbols(filePath).symbols) {
      const actual = caseSensitive ? item.name : item.name.toLowerCase();
      if (actual !== expected || (kind && item.kind.toLowerCase() !== kind)) continue;
      results.push({ path: path.relative(projectRoot, filePath).split(path.sep).join('/'), ...item });
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }
  return { name, results, count: results.length, truncated: found.truncated || results.length >= maxResults };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findReferences(projectRoot, target, args = {}) {
  const name = String(args.name || '');
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error('name must be one identifier without dots or spaces.');
  const maxResults = boundedInteger(args.max_results, 100, 1, 500);
  const maxFiles = boundedInteger(args.max_files, 500, 1, 2_000);
  const includeDefinitions = args.include_definitions !== false;
  const caseSensitive = args.case_sensitive !== false;
  const matcher = new RegExp(`(^|[^A-Za-z0-9_$])(${escapeRegExp(name)})(?=$|[^A-Za-z0-9_$])`, caseSensitive ? 'g' : 'gi');
  const found = sourceFiles(target, maxFiles);
  const results = [];
  for (const filePath of found.files) {
    const parsed = readSymbols(filePath);
    const definitionLines = new Set(parsed.symbols
      .filter((item) => (caseSensitive ? item.name === name : item.name.toLowerCase() === name.toLowerCase()))
      .map((item) => item.line));
    for (let index = 0; index < parsed.lines.length; index += 1) {
      const isDefinition = definitionLines.has(index + 1);
      if (isDefinition && !includeDefinitions) continue;
      matcher.lastIndex = 0;
      let match;
      while ((match = matcher.exec(parsed.lines[index])) !== null) {
        results.push({
          path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
          line: index + 1,
          column: match.index + match[1].length + 1,
          is_definition: isDefinition,
          text: cleanSignature(parsed.lines[index]),
        });
        if (results.length >= maxResults) break;
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
      if (results.length >= maxResults) break;
    }
    if (results.length >= maxResults) break;
  }
  return { name, results, count: results.length, truncated: found.truncated || results.length >= maxResults };
}

module.exports = {
  findReferences,
  findSymbol,
  projectOutline,
  symbolsForLine,
};
