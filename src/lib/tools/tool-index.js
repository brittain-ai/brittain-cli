// Ported from brittain-code@fa01d50fe707a9f72dfbad3550a56fe60effa14b:src/tools/tool-index.js
// Full schemas for every tool would use much of the CLI's 3,000-token fixed
// prompt budget. The source tool set used this index for the same reason.
//
// So the payload is split. A short list of tools used almost every turn keeps
// its full schema. Everything else is advertised with its name, its first
// sentence, and the names and types of its required arguments — enough for the
// model to pick it and usually to call it correctly — with the descriptions and
// optional arguments left out. A tool that is called without the arguments it
// needs has its real schema handed back as the tool result rather than an
// error, and is promoted to full for the rest of the conversation.
//
// The stubs are still declared as ordinary tools rather than listed in the
// system prompt. That is deliberate: a server doing guided or grammar-based
// tool parsing (vLLM's qwen3_xml among them) constrains generation to the
// declared tools, so a tool named only in prose may be one the model is
// incapable of emitting a call for.

function definitionOf(tool) {
  return tool?.function || tool || {};
}

// One sentence is enough to choose a tool; the rest of a description explains
// how to use it, which is what the reveal is for.
function firstSentence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const end = clean.search(/[.!?](?:\s|$)/);
  return end === -1 ? clean : clean.slice(0, end + 1);
}

function requiredSignature(parameters) {
  const required = Array.isArray(parameters?.required) ? parameters.required : [];
  if (!required.length) return { type: 'object', additionalProperties: true };
  const properties = {};
  for (const key of required) {
    const type = parameters?.properties?.[key]?.type;
    properties[key] = type ? { type } : {};
  }
  // additionalProperties stays open: the optional arguments were dropped from
  // this stub, not from the tool, and a model that already knows one must be
  // able to pass it without a round trip to read the schema it guessed right.
  return { type: 'object', properties, required: [...required], additionalProperties: true };
}

function stubDefinition(tool) {
  const definition = definitionOf(tool);
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: firstSentence(definition.description),
      parameters: requiredSignature(definition.parameters),
    },
  };
}

// Which required arguments a call is missing. An empty result means the call can
// be run as-is, whether or not the model has seen the full schema.
function missingRequired(tool, args) {
  const required = definitionOf(tool)?.parameters?.required;
  if (!Array.isArray(required)) return [];
  const supplied = args && typeof args === 'object' ? args : {};
  return required.filter((key) => supplied[key] === undefined || supplied[key] === '');
}

// What a stubbed tool returns in place of running. Deliberately a tool result
// rather than an error: the model asked for a real tool and the call was
// well-formed, it just had not been told what the arguments were.
function schemaReveal(tool) {
  const definition = definitionOf(tool);
  return [
    `Full schema for ${definition.name} (its arguments were abbreviated until now — nothing has run yet):`,
    JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
    'Call it again with these arguments.',
  ].join('\n');
}

// Tools the model has already called in this conversation. Derived from the
// transcript rather than tracked in a variable, so it survives a chat being
// saved, reloaded, or compacted without a reset hook at every one of those
// points — and so the context inspector and the agent turn cannot disagree.
function revealedToolNames(messages) {
  const revealed = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const call of message?.tool_calls || []) {
      const name = call?.function?.name;
      if (name) revealed.add(String(name));
    }
  }
  return revealed;
}

// The payload actually sent: hot tools and anything already used keep their full
// schema, the rest are stubbed.
function indexToolDefs(tools, { hot, revealed } = {}) {
  const hotNames = hot instanceof Set ? hot : new Set(hot || []);
  const revealedNames = revealed instanceof Set ? revealed : new Set(revealed || []);
  return (tools || []).map((tool) => {
    const name = definitionOf(tool).name;
    if (!name || hotNames.has(name) || revealedNames.has(name)) return tool;
    return stubDefinition(tool);
  });
}

function isStubbed(tool, { hot, revealed } = {}) {
  const name = definitionOf(tool).name;
  if (!name) return false;
  const hotNames = hot instanceof Set ? hot : new Set(hot || []);
  const revealedNames = revealed instanceof Set ? revealed : new Set(revealed || []);
  return !hotNames.has(name) && !revealedNames.has(name);
}

module.exports = {
  firstSentence,
  indexToolDefs,
  isStubbed,
  missingRequired,
  requiredSignature,
  revealedToolNames,
  schemaReveal,
  stubDefinition,
};
