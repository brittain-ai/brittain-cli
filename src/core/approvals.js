// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:main.js "---------- approval flow ----------"
'use strict';

// Whether a tool call runs, is put to a human, or is refused.
//
// win.webContents.send('approval:request') becomes an approval:request event
// plus host.approve(); the answer can also arrive through the `approve`
// command, whichever comes first.
//
// Pruned: MCP classification and trust, network verdicts, parking and
// deferral (an unattended ask is a denial — see lib/autonomy.js), custom
// policies and the project autonomy overlay, and the per-run decision log that
// fed the review tray.
//
// Added for the CLI:
//   - "always this session" for an ordinary risky tool. It never reaches an
//     invariant: a destructive, sensitive, or financial call asks every time.
//     For run_command it covers the program, not the tool: "always" on
//     `ls -la` allows `ls`, never `kill` or `npm start`.
//   - an identical call the person already denied in this turn is refused
//     without asking again, so a model that ignores "do not retry" cannot turn
//     one refusal into a stream of prompts.

const path = require('path');
const { decide: decideAutonomy, getPolicy, policyForLegacyAutoApprove } = require('../lib/autonomy');
const { callSignature } = require('../lib/tool-failure');
const { RISKY_TOOLS, SENSITIVE_TOOLS, DESTRUCTIVE_TOOLS, isDestructiveCommand } = require('../lib/tools');

// A best-effort signal that a call is trying to move money — a checkout, a
// payment API, a transfer, a crypto send. It is a heuristic backstop, not a
// guarantee: it errs toward flagging, because a false prompt costs a keypress
// and a missed one costs real money. The policy turns any hit into an approval
// moment that no permissive setting can waive.
// Tuned for precision, not recall: a coding agent trips over bare words like
// "order" or "payment" constantly, so these require the shape of an actual
// money-moving action — a payment-provider API path, a checkout/purchase
// phrase, or a crypto send with a currency.
const FINANCIAL_PATTERNS = [
  /\/(?:v\d+\/)?(?:charges|payment_intents|payments|transfers|payouts|checkout(?:\/sessions)?|orders\/[^/\s]+\/(?:pay|capture))\b/i,
  /\b(?:place|submit|confirm|complete)\s+(?:the\s+)?(?:order|purchase|payment)\b/i,
  /\b(?:buy\s+now|check\s?out\s+now|pay\s+now|confirm\s+and\s+pay)\b/i,
  /\b(?:stripe|paypal|braintree|coinbase|binance)\b[^\n]{0,60}\b(?:charge|payment|checkout|transfer|payout)\b/i,
  /\b(?:send|transfer|withdraw|swap)\b[^\n]{0,40}\b(?:eth|btc|usdc|usdt|sol|wallet)\b/i,
];

function looksFinancial(name, args) {
  const haystack = [
    args?.command, args?.url, args?.body, args?.data,
    typeof args === 'object' ? JSON.stringify(args) : '',
  ].filter(Boolean).join(' ');
  return FINANCIAL_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isSensitivePath(value) {
  const basename = path.basename(String(value || '')).toLowerCase();
  return basename === '.env' || basename.startsWith('.env.')
    || ['.npmrc', '.pypirc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json', 'secrets.json'].includes(basename)
    || /(?:^|[-_.])(?:private[-_.]?key|service[-_.]?account)(?:[-_.]|$)/.test(basename)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(basename);
}

// Deviation: the source gated read_file alone. get_file_lines and a
// search_files aimed at one file read the same bytes, so they are gated too.
const PATH_READING_TOOLS = new Set(['read_file', 'get_file_lines', 'search_files']);

function isSensitiveToolCall(name, args) {
  if (SENSITIVE_TOOLS.has(name)) return true;
  if (!PATH_READING_TOOLS.has(name)) return false;
  return isSensitivePath(args?.path);
}

// Classifying a call once, in one place, is what lets the policy answer the
// same question the approval chain used to answer inline six times over.
function classifyToolCall(name, args) {
  return {
    name,
    destructive: DESTRUCTIVE_TOOLS.has(name)
      || (name === 'run_command' && isDestructiveCommand(args?.command))
      || (name === 'local_http_request' && !['GET', 'HEAD'].includes(String(args?.method || 'GET').toUpperCase())),
    sensitive: isSensitiveToolCall(name, args),
    risky: RISKY_TOOLS.has(name),
    financial: looksFinancial(name, args),
  };
}

function describeCallTarget(name, args) {
  if (name === 'run_command') return String(args?.command || '').slice(0, 120);
  return String(args?.path || args?.destination || '').slice(0, 120);
}

// The programs a command runs, one per segment (`a && b | c` → a, b, c), or
// null when "always" cannot safely cover it: a command substitution, a
// subshell, or a redirect into a file could do anything under a harmless name.
const SHELL_SEPARATORS = /&&|\|\||[;|&\n]/;
function commandPrograms(command) {
  const text = String(command || '').replace(/\d?>&\d|\d?>\s*\/dev\/null/g, ' ');
  if (!text.trim() || /\$\(|`|[<>]\(|[<>]|[(){}]/.test(text)) return null;
  const programs = [];
  for (const segment of text.split(SHELL_SEPARATORS)) {
    const words = segment.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (!words.length || !words[0]) continue;
    if (!/^[\w./@+-]+$/.test(words[0])) return null;
    programs.push(path.basename(words[0]));
  }
  return programs.length ? [...new Set(programs)] : null;
}

// What "always" would remember for this call, or null when it is not offered.
function alwaysScope(name, args) {
  if (name !== 'run_command') return { keys: [name], label: 'this session' };
  const programs = commandPrograms(args?.command);
  if (!programs) return null;
  return { keys: programs.map((program) => `run_command:${program}`), label: `${programs.join(', ')} this session` };
}

// The tool result the model sees for a call that was not approved. A denial
// keeps the branch's own wording so the model knows what kind of thing was
// refused; a call refused because nobody was there to ask says so.
function unapprovedResult(verdict, deniedText) {
  if (verdict === 'deny') {
    return 'This tool call was not permitted: it needs the user\'s approval and nobody is available to give it. Do not retry it; continue without it, or finish and say what was not done.';
  }
  return deniedText;
}

function createApprovals(rt) {
  const pending = new Map();
  rt.approvals = { pending, always: new Set(), deniedThisTurn: new Set() };

  function activePolicy(autoApprove) {
    const id = policyForLegacyAutoApprove(!!autoApprove);
    return { id, policy: getPolicy(id) };
  }

  // Resolves with true, false, or 'always'. The host answers, or the
  // `approve` command does — whichever is first.
  function requestApproval(info) {
    const id = Math.random().toString(36).slice(2);
    const request = { id, ...info };
    return new Promise((resolve) => {
      const settle = (answer) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rt.sink.emit('approval:resolved', { id, approved: answer === 'always' ? true : !!answer });
        resolve(answer === 'always' ? 'always' : !!answer);
      };
      pending.set(id, settle);
      rt.sink.emit('approval:request', request);
      Promise.resolve()
        .then(() => rt.host.approve(request))
        .then(settle, () => settle(false));
    });
  }

  function answerApproval(id, approved) {
    const settle = pending.get(String(id || ''));
    if (!settle) return { ok: false, error: 'No approval is waiting with that id.' };
    settle(approved === 'always' ? 'always' : !!approved);
    return { ok: true };
  }

  // Resolves one tool call to an executable decision. With nobody watching, a
  // call that would have prompted is denied instead of hanging.
  async function resolveToolCall(name, args, { autoApprove, promptKind = {} }) {
    const { id, policy } = activePolicy(autoApprove);
    const call = classifyToolCall(name, args);
    const attended = !!rt.host.interactive();
    const invariant = call.destructive || call.sensitive || call.financial;
    const decision = decideAutonomy(policy, { ...call, attended });

    if (decision.verdict === 'allow') return { approved: true, ...decision, policyId: id };
    if (decision.verdict === 'deny') {
      rt.sink.info(`Denied ${name} — ${decision.reason}, and nobody is here to approve it.`);
      return { approved: false, ...decision, policyId: id };
    }

    // decision.verdict === 'ask'
    const scope = invariant ? null : alwaysScope(name, args);
    if (scope && scope.keys.every((key) => rt.approvals.always.has(key))) {
      return { approved: true, verdict: 'allow', reason: 'approved for this session', policyId: id };
    }
    const signature = callSignature(name, args);
    if (rt.approvals.deniedThisTurn.has(signature)) {
      return { approved: false, verdict: 'ask', reason: 'already denied this turn', repeatDenied: true, policyId: id };
    }
    // A financial call is surfaced as such even when the caller passed a
    // different promptKind, so the human sees what they are approving.
    const kind = {
      ...promptKind,
      ...(call.destructive ? { destructive: true } : {}),
      ...(call.sensitive ? { sensitive: true } : {}),
      ...(call.financial ? { financial: true } : {}),
    };
    const answer = await requestApproval({ name, args, target: describeCallTarget(name, args), reason: decision.reason, kind, always: scope ? scope.label : null });
    if (answer === 'always' && scope) for (const key of scope.keys) rt.approvals.always.add(key);
    const approved = answer === 'always' || answer === true;
    if (!approved) rt.approvals.deniedThisTurn.add(signature);
    return { approved, ...decision, policyId: id };
  }

  function beginTurn() {
    rt.approvals.deniedThisTurn.clear();
  }

  return {
    activePolicy,
    answerApproval,
    beginTurn,
    requestApproval,
    resolveToolCall,
  };
}

module.exports = {
  FINANCIAL_PATTERNS,
  alwaysScope,
  classifyToolCall,
  commandPrograms,
  createApprovals,
  describeCallTarget,
  isSensitivePath,
  isSensitiveToolCall,
  looksFinancial,
  unapprovedResult,
};
