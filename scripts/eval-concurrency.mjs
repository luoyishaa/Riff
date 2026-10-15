#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DOCUMENT =
  '协作文档的第一段用于测试锚点。\n\n第二段保留几个可重复的词语：协作、建议、协作。\n\n第三段用于并发编辑和评论。';

function usage() {
  console.error(
    'Usage: pnpm eval:concurrency [--clients 4] [--steps 200] [--seed 42] [--out result.json]',
  );
}

function parseArgs(argv) {
  const values = {
    clients: 4,
    steps: 200,
    seed: 42,
    outputPath: undefined,
    document: DEFAULT_DOCUMENT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const read = (name) =>
      arg === `--${name}`
        ? next
        : arg?.startsWith(`--${name}=`)
          ? arg.slice(name.length + 3)
          : undefined;
    const clients = read('clients');
    const steps = read('steps');
    const seed = read('seed');
    const output = read('out');
    const document = read('document');
    if (clients !== undefined) {
      values.clients = Number(clients);
      if (arg === '--clients') index += 1;
    } else if (steps !== undefined) {
      values.steps = Number(steps);
      if (arg === '--steps') index += 1;
    } else if (seed !== undefined) {
      values.seed = Number(seed);
      if (arg === '--seed') index += 1;
    } else if (output !== undefined) {
      values.outputPath = output;
      if (arg === '--out') index += 1;
    } else if (document !== undefined) {
      values.document = document;
      if (arg === '--document') index += 1;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
  }
  if (!Number.isInteger(values.clients) || values.clients < 1)
    throw new Error('--clients must be a positive integer');
  if (!Number.isInteger(values.steps) || values.steps < 1)
    throw new Error('--steps must be a positive integer');
  if (!Number.isInteger(values.seed)) throw new Error('--seed must be an integer');
  return values;
}

function createRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInt(random, maximum) {
  return maximum <= 0 ? 0 : Math.floor(random() * maximum);
}

function allMatches(text, quote) {
  if (!quote) return [];
  const matches = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    matches.push(index);
    from = index + 1;
  }
  return matches;
}

function classifyAnchor(text, anchor) {
  if (anchor.quote && text.slice(anchor.start, anchor.start + anchor.quote.length) === anchor.quote)
    return 'exact';
  const matches = allMatches(text, anchor.quote);
  return matches.length === 1 ? 'relocated' : 'detached';
}

function randomQuote(text, random) {
  if (text.length === 0) return '';
  const start = randomInt(random, text.length);
  const maxLength = Math.min(12, text.length - start);
  const length = Math.max(1, randomInt(random, maxLength + 1));
  return text.slice(start, start + length);
}

function randomToken(step, client) {
  return `〔${client + 1}:${step}〕`;
}

function editDocument(text, random, step, client) {
  if (text.length === 0 || random() < 0.55) {
    const position = randomInt(random, text.length + 1);
    const token = randomToken(step, client);
    return { text: `${text.slice(0, position)}${token}${text.slice(position)}`, kind: 'insert' };
  }
  const start = randomInt(random, text.length);
  const length = Math.min(Math.max(1, randomInt(random, 8)), text.length - start);
  const replacement = random() < 0.3 ? '' : randomToken(step, client);
  return {
    text: `${text.slice(0, start)}${replacement}${text.slice(start + length)}`,
    kind: replacement ? 'replace' : 'delete',
  };
}

function resolvePending(pending, text, counts, stale) {
  const anchor = pending.shift();
  if (!anchor) return false;
  const status = classifyAnchor(text, anchor);
  counts[status] += 1;
  if (status !== 'exact') stale.detected += 1;
  stale.resolved += 1;
  return true;
}

function runSimulation(options) {
  const random = createRandom(options.seed);
  let canonicalText = options.document;
  let version = 0;
  const clients = Array.from({ length: options.clients }, (_, id) => ({
    id,
    text: canonicalText,
    version,
  }));
  const anchors = [];
  const anchorCounts = { exact: 0, relocated: 0, detached: 0 };
  const stale = { detected: 0, resolved: 0 };
  const events = { edits: 0, comments: 0, suggestions: 0, syncs: 0 };
  for (let step = 0; step < options.steps; step += 1) {
    const client = randomInt(random, options.clients);
    const choice = random();
    if (choice < 0.55) {
      const edit = editDocument(canonicalText, random, step, client);
      canonicalText = edit.text;
      version += 1;
      events.edits += 1;
    } else if (choice < 0.77) {
      events.comments += 1;
    } else {
      const quote = randomQuote(canonicalText, random);
      if (quote) {
        const start = canonicalText.indexOf(quote);
        anchors.push({ quote, start, createdVersion: version });
        events.suggestions += 1;
      }
    }
    if (anchors.length > 0 && random() < 0.38)
      resolvePending(anchors, canonicalText, anchorCounts, stale);
    if (random() < 0.2) {
      const syncClient = clients[randomInt(random, clients.length)];
      if (syncClient) {
        syncClient.text = canonicalText;
        syncClient.version = version;
        events.syncs += 1;
      }
    }
  }
  while (anchors.length > 0) resolvePending(anchors, canonicalText, anchorCounts, stale);
  for (const client of clients) {
    client.text = canonicalText;
    client.version = version;
    events.syncs += 1;
  }
  const converged = clients.every(
    (client) => client.text === canonicalText && client.version === version,
  );
  return {
    seed: options.seed,
    clients: options.clients,
    steps: options.steps,
    converged,
    events,
    anchors: anchorCounts,
    stale: {
      detected: stale.detected,
      resolved: stale.resolved,
      rate: stale.resolved === 0 ? 0 : Number((stale.detected / stale.resolved).toFixed(4)),
    },
    finalLength: canonicalText.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runSimulation(options);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) await writeFile(path.resolve(options.outputPath), output, 'utf8');
  process.stdout.write(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
