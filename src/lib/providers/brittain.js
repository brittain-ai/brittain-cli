'use strict';

// The Brittain provider mode: everything specific to the Brittain API lives in
// this one file (docs/PLAN.md §5.2).
//
// The endpoint is kept out of the UI — it is not written to settings.json and
// is never printed by config, /provider, /context, --verbose, or an error. That
// is presentation, not protection: anyone who opens the npm package can read
// the constant below. Access control has to live on the server (keys, rate
// limits), never in the hope that a URL stays unknown.

// BRITTAIN_API_URL overrides the production endpoint for development and tests.
// The endpoint is deliberately left out of --help.
const BRITTAIN_ENDPOINT = 'https://api.brittain.app/v1';

// Which wire protocol the Brittain server speaks: 'openai' or 'ollama'.
// Switching to an Ollama-shaped server is a one-line change here.
const BRITTAIN_TRANSPORT = 'openai';

// How a key is sent. Kept here so the auth scheme can change in one place.
const AUTH_HEADER = 'Authorization';
const AUTH_SCHEME = 'Bearer';

const DEFAULT_MODEL = 'run4c-step-0116';

function brittainEndpoint(env = process.env) {
  const override = String(env?.BRITTAIN_API_URL || '').trim();
  return (override || BRITTAIN_ENDPOINT).replace(/\/+$/, '');
}

// No key, no header: the server decides whether anonymous use is allowed.
function authHeaders(key) {
  return key ? { [AUTH_HEADER]: AUTH_SCHEME ? `${AUTH_SCHEME} ${key}` : key } : {};
}

// Every form the endpoint could take in a message: the full base, the origin,
// and the bare host (with and without its port). Longest first, so the base is
// replaced whole rather than leaving its path behind.
function endpointForms(endpoint) {
  const forms = new Set([endpoint]);
  try {
    const url = new URL(endpoint);
    const pathname = url.pathname.replace(/\/+$/, '');
    forms.add(url.origin);
    // A server echoing the request line or Host header shows host + path.
    forms.add(url.host + pathname);
    forms.add(url.host);
    forms.add(url.hostname);
    // The path alone identifies the endpoint too, unless it is only the
    // generic segments every API has (/v1, /api/v1), which would mangle
    // ordinary text like "/v1/models" for nothing.
    if (!/^(?:\/(?:api|v\d+))*$/i.test(pathname)) forms.add(pathname);
    // Node's DNS errors name the hostname; a URL-encoded copy can turn up in
    // a server's echo of the request.
    forms.add(encodeURIComponent(endpoint));
  } catch {}
  return [...forms].filter((form) => form && form.length >= 4).sort((a, b) => b.length - a.length);
}

function redactEndpoint(text, env = process.env) {
  let out = String(text ?? '');
  for (const form of endpointForms(brittainEndpoint(env))) {
    out = out.split(form).join('the Brittain API');
  }
  return out;
}

module.exports = {
  AUTH_HEADER,
  AUTH_SCHEME,
  BRITTAIN_ENDPOINT,
  BRITTAIN_TRANSPORT,
  DEFAULT_MODEL,
  authHeaders,
  brittainEndpoint,
  redactEndpoint,
};
