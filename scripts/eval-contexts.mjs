#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import path from 'node:path';

const STRATEGIES = ['selection', 'window', 'full'];
const DEFAULT_MAX_CHARS = 4000;

function usage() {
  console.error('Usage: pnpm eval:contexts <taskset.json> [--out result.csv]');
}

function parseArgs(argv) {
  let tasksetPath;
  let outputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--out') {
      outputPath = argv[index + 1];
      index += 1;
    } else if (value?.startsWith('--out=')) {
      outputPath = value.slice('--out='.length);
    } else if (!value?.startsWith('-') && tasksetPath === undefined) {
      tasksetPath = value;
    }
  }
  return { tasksetPath, outputPath };
}

function asTaskList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.tasks)) return value.tasks;
  throw new Error('taskset must be an array or an object with a tasks array');
}

function textValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function normaliseSelection(task, documentText) {
  if (!task.selection || typeof task.selection !== 'object') return undefined;
  const start = Number(task.selection.start);
  const end = Number(task.selection.end);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > documentText.length
  )
    return undefined;
  return { start, end };
}

function buildContext(task, strategy) {
  const documentText = textValue(task.document ?? task.documentText);
  const selection = normaliseSelection(task, documentText);
  const messages = Array.isArray(task.messages) ? task.messages : [];
  const maxChars =
    Number.isInteger(task.maxChars) && task.maxChars > 0 ? task.maxChars : DEFAULT_MAX_CHARS;
  const parts = [];
  const selectedText = selection ? documentText.slice(selection.start, selection.end) : undefined;

  if (strategy === 'full' || selection === undefined) {
    parts.push(`全文：\n${documentText}`);
  } else if (strategy === 'selection') {
    parts.push(`选区：\n${selectedText ?? ''}`);
  } else {
    const paragraphs = documentText.split(/\n\s*\n/);
    const center = documentText.slice(0, selection.start).split(/\n\s*\n/).length - 1;
    const radius = Number.isInteger(task.windowParagraphs) ? Math.max(0, task.windowParagraphs) : 2;
    parts.push(`选区：\n${selectedText ?? ''}`);
    parts.push(
      `上下文：\n${paragraphs.slice(Math.max(0, center - radius), center + radius + 1).join('\n\n')}`,
    );
    parts.push(
      `大纲：\n${paragraphs.map((paragraph) => paragraph.split('\n')[0]?.slice(0, 60) ?? '').join('\n')}`,
    );
  }
  if (messages.length > 0) {
    parts.push(
      `线程：\n${messages.map((message) => `${textValue(message?.author, 'unknown')}: ${textValue(message?.body)}`).join('\n')}`,
    );
  }
  const previousText = textValue(task.previousText);
  if (previousText && previousText !== documentText) {
    parts.push(
      `自上次查看以来，人类修改了文档；请不要撤销这些修改。\n${previousText.slice(0, 2000)}\n→\n${documentText.slice(0, 2000)}`,
    );
  }
  let contextText = parts.join('\n\n');
  if (contextText.length > maxChars)
    contextText = `${contextText.slice(0, Math.max(0, maxChars - 20))}\n[上下文已截断]`;
  return {
    text: contextText,
    allowedText: selectedText ?? documentText,
    inputChars: contextText.length,
  };
}

function latestHumanMessage(task) {
  const messages = Array.isArray(task.messages) ? task.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.agent !== true && message.kind !== 'agent')
      return textValue(message.body);
  }
  return textValue(task.trigger);
}

function mockOutput(task, allowedText) {
  const trigger = latestHumanMessage(task);
  const match =
    /replace\s+"([^"]*)"\s+with\s+"([^"]*)"/i.exec(trigger) ??
    /把「([^」]*)」改成「([^」]*)」/.exec(trigger);
  if (!match) return JSON.stringify({ reply: `收到：${trigger}`, edits: [] });
  const quote = match[1] ?? '';
  const newText = match[2] ?? '';
  const exists = quote.length > 0 && allowedText.includes(quote);
  return JSON.stringify({
    reply: exists ? `已提出将“${quote}”改为“${newText}”。` : `找不到需要修改的原文“${quote}”。`,
    edits: [{ op: 'replace', quote, newText }],
  });
}

function firstJsonObject(raw) {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (start < 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

function occurrences(text, quote) {
  if (!quote) return [];
  const result = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    result.push(index);
    from = index + 1;
  }
  return result;
}

function validateOutput(raw, allowedText) {
  const source = firstJsonObject(raw);
  if (source === undefined) return { valid: false, suggestionCount: 0 };
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return { valid: false, suggestionCount: 0 };
  }
  if (!value || typeof value !== 'object' || typeof value.reply !== 'string') {
    return { valid: false, suggestionCount: 0 };
  }
  const outputKeys = Object.keys(value);
  if (outputKeys.some((key) => !['reply', 'edits'].includes(key))) {
    return { valid: false, suggestionCount: 0 };
  }
  const edits = value.edits === undefined ? [] : value.edits;
  if (!Array.isArray(edits)) return { valid: false, suggestionCount: 0 };
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit !== 'object' ||
      !['replace', 'delete', 'insert'].includes(edit.op) ||
      typeof edit.quote !== 'string' ||
      (edit.newText !== undefined && typeof edit.newText !== 'string') ||
      (edit.contextBefore !== undefined && typeof edit.contextBefore !== 'string') ||
      (edit.contextAfter !== undefined && typeof edit.contextAfter !== 'string') ||
      (edit.rationale !== undefined && typeof edit.rationale !== 'string') ||
      Object.keys(edit).some(
        (key) =>
          !['op', 'quote', 'newText', 'contextBefore', 'contextAfter', 'rationale'].includes(key),
      )
    )
      return { valid: false, suggestionCount: 0 };
  }
  const accepted = [];
  for (const edit of edits.slice(0, 50)) {
    const candidates = occurrences(allowedText, edit.quote).filter((start) => {
      const before =
        edit.contextBefore === undefined ||
        (typeof edit.contextBefore === 'string' &&
          allowedText.slice(Math.max(0, start - edit.contextBefore.length), start) ===
            edit.contextBefore);
      const afterStart = start + edit.quote.length;
      const after =
        edit.contextAfter === undefined ||
        (typeof edit.contextAfter === 'string' &&
          allowedText.slice(afterStart, afterStart + edit.contextAfter.length) ===
            edit.contextAfter);
      return before && after;
    });
    if (candidates.length !== 1) continue;
    const start = candidates[0];
    const end = start + edit.quote.length;
    if (accepted.some((item) => start < item.end && item.start < end)) continue;
    accepted.push({ start, end });
  }
  return { valid: true, suggestionCount: accepted.length };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const { tasksetPath, outputPath } = parseArgs(process.argv.slice(2));
  if (!tasksetPath) {
    usage();
    process.exitCode = 1;
    return;
  }
  const source = await readFile(path.resolve(tasksetPath), 'utf8');
  const tasks = asTaskList(JSON.parse(source));
  const rows = [];
  for (const [taskIndex, task] of tasks.entries()) {
    if (!task || typeof task !== 'object') throw new Error(`task ${taskIndex} must be an object`);
    const taskId = textValue(task.id, `task-${taskIndex + 1}`);
    for (const strategy of STRATEGIES) {
      const started = performance.now();
      const context = buildContext(task, strategy);
      const configuredOutputs = Array.isArray(task.rawOutputs) ? task.rawOutputs : undefined;
      let retries = 0;
      let result = { valid: false, suggestionCount: 0 };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const raw = textValue(configuredOutputs?.[attempt], mockOutput(task, context.allowedText));
        result = validateOutput(raw, context.allowedText);
        if (result.valid || attempt === 1) break;
        retries += 1;
      }
      const latency = Math.max(0, Math.round(performance.now() - started));
      rows.push({
        strategy,
        task: taskId,
        validity: result.valid ? 'valid' : 'invalid',
        retries,
        latency,
        inputChars: context.inputChars,
        suggestionCount: result.suggestionCount,
      });
    }
  }
  const header = [
    'strategy',
    'task',
    'validity',
    'retries',
    'latency',
    'inputChars',
    'suggestionCount',
  ];
  const csv =
    [header, ...rows.map((row) => header.map((key) => csvCell(row[key])))]
      .map((row) => row.join(','))
      .join('\n') + '\n';
  if (outputPath) await writeFile(path.resolve(outputPath), csv, 'utf8');
  process.stdout.write(csv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
