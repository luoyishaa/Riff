const baseUrl = process.env.QA_BASE_URL ?? 'http://127.0.0.1:8799';
const unique = `qa-${Date.now()}`;
let cookie = '';

async function request(path, init = {}) {
  const headers = { 'content-type': 'application/json', ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  return body;
}

async function post(path, body) {
  return request(path, { method: 'POST', body: JSON.stringify(body) });
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

const original = '研究结果显示，团队协作能够提升文档质量。';
const replacement = '已有研究表明，结构化团队协作能够显著提升文档质量与可复用性。';
const documentText = `${original}\n\n我们将继续评估系统效果。`;
const extensionRequest = '@Polisher QA 请扩展这句话，补充研究背景、协作机制和可验证的实际收益，保持中文表达自然，并给出可审批的修改建议。';
const replacementRequest = `@Polisher QA 把「${original}」改成「${replacement}」`;

const result = {
  baseUrl,
  scenario: 'selection -> @agent task -> suggestion -> approval -> document update',
  naturalLanguage: {},
  exactReplacement: {},
};

const account = await post('/api/auth/register', {
  handle: unique,
  displayName: 'QA Owner',
  password: 'qa-pass-123',
});
const workspace = await post('/api/workspaces', { title: `QA 产品验收 ${unique}` });
const document = await post(`/api/workspaces/${workspace.id}/documents`, { title: '协作写作验收文档', text: documentText });
const agentResponse = await post(`/api/docs/${document.id}/agents`, {
  displayName: 'Polisher QA',
  provider: 'mock',
  grantedRole: 'editor',
  contextStrategy: 'selection',
  accessPolicy: 'public',
});
const agentId = agentResponse.principal.id;

const thread = await post(`/api/docs/${document.id}/threads`, {
  kind: 'task',
  agentId,
  scope: { type: 'range', start: 0, end: original.length },
});
await post(`/api/threads/${thread.id}/messages`, { body: extensionRequest });
const naturalState = await waitFor(async () => {
  const threads = await request(`/api/docs/${document.id}/threads`);
  const current = threads.find((item) => item.id === thread.id);
  const messages = current?.messages ?? [];
  const runs = await request(`/api/docs/${document.id}/agent-runs`);
  const run = runs.find((item) => item.threadId === thread.id);
  if (!run || messages.length < 2) return undefined;
  return { messages, run };
});
result.naturalLanguage = {
  request: extensionRequest,
  agentReply: naturalState?.messages?.at(-1)?.body ?? null,
  suggestionCount: (await request(`/api/docs/${document.id}/suggestions`)).length,
  run: naturalState?.run ?? null,
  usable: (await request(`/api/docs/${document.id}/suggestions`)).length > 0,
};

await post(`/api/threads/${thread.id}/messages`, { body: replacementRequest });
const exactState = await waitFor(async () => {
  const suggestions = await request(`/api/docs/${document.id}/suggestions`);
  const pending = suggestions.find((item) => item.status === 'pending');
  const threads = await request(`/api/docs/${document.id}/threads`);
  const current = threads.find((item) => item.id === thread.id);
  const messages = current?.messages ?? [];
  if (!pending || messages.length < 3) return undefined;
  return { pending, messages };
});
if (!exactState) throw new Error('Timed out waiting for a pending exact replacement suggestion');
const accepted = await post(`/api/suggestions/${exactState.pending.id}/accept`, {});
const finalDocument = await request(`/api/docs/${document.id}`);
const runs = await request(`/api/docs/${document.id}/agent-runs`);
result.exactReplacement = {
  request: replacementRequest,
  agentReply: exactState.messages.at(-1)?.body ?? null,
  suggestion: exactState.pending,
  accepted: accepted.status === 'accepted' || accepted.suggestion?.status === 'accepted',
  documentUpdated: finalDocument.text.includes(replacement) && !finalDocument.text.includes(original),
  run: runs.at(-1) ?? null,
};
result.pass = result.exactReplacement.accepted && result.exactReplacement.documentUpdated;
console.log(JSON.stringify({ account: account.principal?.handle ?? unique, workspace: workspace.id, document: document.id, ...result }, null, 2));
if (!result.pass) process.exitCode = 1;
