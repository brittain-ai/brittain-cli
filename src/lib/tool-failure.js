// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/main/tool-failure.js
'use strict';

function stableSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',') + '}';
  }
  return JSON.stringify(value);
}

function callSignature(name, args) {
  return `${String(name || '')}:${stableSerialize(args || {})}`;
}

function isToolErrorResult(result) {
  return /^\s*Error:/i.test(String(result || ''));
}

function createToolFailureTracker(limit = 2) {
  const failures = new Map();
  const threshold = Math.max(1, Number(limit) || 2);

  return {
    shouldBlock(name, args) {
      return (failures.get(callSignature(name, args)) || 0) >= threshold;
    },
    record(name, args, result) {
      const signature = callSignature(name, args);
      if (!isToolErrorResult(result)) {
        failures.delete(signature);
        return { count: 0, reachedLimit: false };
      }
      const count = (failures.get(signature) || 0) + 1;
      failures.set(signature, count);
      return { count, reachedLimit: count === threshold };
    },
  };
}

// CLI addition. The failure tracker only stops a call that keeps failing; a
// model can also loop on calls that succeed — one session ran the same `open`
// and the same `curl | grep` eight times each, pasting the same paragraph
// between them. Other calls with the same result twice are not run a third
// time. A successful file read is blocked on its second call if the file did
// not change. A successful edit resets the tracker.
const REPEAT_LIMIT = 2;
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'delete_file', 'move_file']);
const FILE_READ_TOOLS = new Set(['read_file', 'get_file_lines']);
function createRepeatTracker(limit = REPEAT_LIMIT) {
  const seen = new Map();
  return {
    shouldBlock(name, args, fileVersion = null) {
      const last = seen.get(callSignature(name, args));
      if (FILE_READ_TOOLS.has(name) && last?.fileVersion && fileVersion === last.fileVersion) return true;
      return (last?.count || 0) >= limit;
    },
    record(name, args, result, fileVersion = null) {
      if (EDIT_TOOLS.has(name) && !/^\s*Error:/i.test(String(result || ''))) {
        seen.clear();
        return;
      }
      const signature = callSignature(name, args);
      const last = seen.get(signature);
      const text = String(result || '');
      const successfulRead = Boolean(FILE_READ_TOOLS.has(name) && !isToolErrorResult(text) && fileVersion);
      seen.set(signature, {
        result: text,
        count: successfulRead ? 1 : last && last.result === text ? last.count + 1 : 1,
        fileVersion: successfulRead ? fileVersion : null,
      });
    },
  };
}

module.exports = { callSignature, createRepeatTracker, createToolFailureTracker, isToolErrorResult, stableSerialize };
