import { useState } from 'react';
import type { AgentSummaryDto, MemberDto } from '@collab/protocol';
import { MentionInput } from './MentionInput.js';

export interface NewDiscussionProps {
  members: MemberDto[];
  agents: AgentSummaryDto[];
  /** Resolves true once the thread exists. */
  onSubmit: (body: string, agentId: string | undefined) => Promise<boolean>;
  onCancel: () => void;
}

/** A discussion about the whole document, optionally handed to an agent as a task. */
export function NewDiscussion({ members, agents, onSubmit, onCancel }: NewDiscussionProps): React.ReactElement {
  const [body, setBody] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (): Promise<void> => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const created = await onSubmit(body.trim(), agentId || undefined);
    setBusy(false);
    if (created) setBody('');
  };
  return (
    <div className="new-discussion">
      <MentionInput value={body} onChange={setBody} members={members} placeholder={agentId ? '描述要 Agent 完成的任务，例如：统一全文术语' : '对整篇文档发起讨论，输入 @ 提及成员或 Agent'} ariaLabel="新讨论内容" onSubmit={() => void submit()} onCancel={onCancel} autoFocus rows={3} disabled={busy} />
      <div className="new-discussion-options">
        <label className="inline-field">
          <span>作为任务交给</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            <option value="">不指派（普通讨论）</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
          </select>
        </label>
        <div className="row-actions">
          <button type="button" className="button ghost small" onClick={onCancel}>取消</button>
          <button type="button" className="button primary small" disabled={!body.trim() || busy} onClick={() => void submit()}>{agentId ? '发布任务' : '发布'}</button>
        </div>
      </div>
    </div>
  );
}
