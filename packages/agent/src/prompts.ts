/**
 * Section headers of the plain-text prompt. The context builder writes them,
 * the mock adapter reads them back; keeping both sides on these constants is
 * what lets the prompt wording change without silently breaking the mock.
 */
export const PROMPT_SECTIONS = {
  selection: '选区：',
  window: '上下文：',
  outline: '大纲：',
  fullText: '全文：',
  consistency: '全文一致性检查素材（只读）：',
  thread: '线程：',
  humanEdits: '自上次查看以来，人类修改了文档；请不要撤销这些修改。',
  trigger: '触发消息：',
} as const;

export const AGENT_SYSTEM_PROMPT = [
  '你是协作写作助手。',
  '只根据本次触发消息执行，不要把线程中的旧请求当作当前指令。',
  '用户要求扩展、改写、润色或替换时，必须在 edits 中给出可审批的文本修改；如果无需修改或用户只是在提问，edits 可以为空。',
  '选区之外的内容只作为全文一致性检查素材；如果修改会影响其他位置的术语、指代、链接或依赖引用，只在 relatedEdits 中提出额外建议。edits 只能改选区，relatedEdits 才能改全文其他位置；没有明确影响时 relatedEdits 必须为空。',
  'relatedEdits 只提出能由原文直接验证的同步修改，不要直接改正文。',
  '每个 edit 必须使用字段 op、quote、newText，可选 contextBefore、contextAfter、rationale；op 只能是 replace、delete 或 insert。replace 必须把 quote 逐字替换为 newText。不要使用 replacement、oldText、changes 或其他字段名。',
  '始终只返回一个合法 JSON 对象，字段为 reply（字符串）、edits（数组）和 relatedEdits（数组，可为空）；不要输出 Markdown、代码围栏或额外文字。',
  '修改必须限定在允许区域，保持原文语言，理由用一句话。',
  '如果引用包含 Markdown 标题、列表、引用、代码围栏、表格或分隔线，newText 必须保留相同顺序和结构标记，只改其中的内容；不要把结构行吞掉。',
].join('\n');

export const RETRY_INSTRUCTION = 'Previous output was invalid. Return one JSON object matching the required protocol.';

/** The trigger is always the last section so a reader can take everything after it. */
export function buildAgentPrompt(contextText: string, triggerBody: string): { system: string; user: string } {
  const sections = contextText ? [contextText] : [];
  sections.push(`${PROMPT_SECTIONS.trigger}${triggerBody}`);
  return { system: AGENT_SYSTEM_PROMPT, user: sections.join('\n\n') };
}

const sectionHeaders = Object.values(PROMPT_SECTIONS);

function lineStartOccurrences(text: string, header: string): number[] {
  const found: number[] = [];
  for (let index = text.indexOf(header); index >= 0; index = text.indexOf(header, index + 1)) {
    if (index === 0 || text[index - 1] === '\n') found.push(index);
  }
  return found;
}

/**
 * Read one section body from a prompt built by `buildContext` and
 * `buildAgentPrompt`. Headers start a line; a section ends where the next
 * known header starts a line. Every section except the trigger is written
 * before any document text, so its first occurrence is the real one; the
 * trigger is appended last, so its last occurrence is.
 */
export function readPromptSection(prompt: string, header: string): string | undefined {
  const isTrigger = header === PROMPT_SECTIONS.trigger;
  const occurrences = lineStartOccurrences(prompt, header);
  const at = isTrigger ? occurrences[occurrences.length - 1] : occurrences[0];
  if (at === undefined) return undefined;
  const rest = prompt.slice(at + header.length);
  if (isTrigger) return rest;
  const nextHeader = Math.min(rest.length, ...sectionHeaders.flatMap((candidate) => lineStartOccurrences(rest, candidate).filter((index) => index > 0)));
  const separator = rest.slice(0, nextHeader).match(/\n{1,2}$/u)?.[0].length ?? 0;
  return rest.slice(0, nextHeader - separator).replace(/^\n/u, '');
}
