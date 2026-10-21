import type { AgentStatusEventDto, AgentSummaryDto, DocumentVersionDto, MemberDto, Role, SuggestionDto, ThreadDto } from '@collab/protocol';
import type { useReviewActions } from '../hooks/useReviewActions.js';
import { can } from '../lib/permissions.js';
import { Icon } from './Icon.js';
import { MembersPanel } from './MembersPanel.js';
import { NewDiscussion } from './NewDiscussion.js';
import { ThreadList } from './ThreadList.js';
import { ThreadView } from './ThreadView.js';

export type InspectorTab = 'discussion' | 'members';

export interface InspectorProps {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  openThread: ThreadDto | undefined;
  composing: boolean;
  threads: ThreadDto[];
  suggestions: SuggestionDto[];
  versions: DocumentVersionDto[];
  activity: Record<string, AgentStatusEventDto>;
  agents: AgentSummaryDto[];
  members: MemberDto[];
  mentionable: MemberDto[];
  onlineIds: Set<string>;
  viewerId: string;
  role: Role;
  workspaceRole: Role | undefined;
  identify: (principalId: string) => { name: string; kind: 'human' | 'agent' };
  actions: ReturnType<typeof useReviewActions>;
  onOpenThread: (thread: ThreadDto) => void;
  onCloseThread: () => void;
  onCompose: (composing: boolean) => void;
  onCreateDiscussion: (body: string, agentId: string | undefined) => Promise<boolean>;
  onLocate: (start: number, end: number) => void;
  onManageMembers: () => void;
  onConfigureAgent: (agentId: string) => void;
  onAddAgent: () => void;
}

export function Inspector(props: InspectorProps): React.ReactElement {
  const { tab, openThread, threads, actions } = props;
  const unread = threads.filter((thread) => thread.unread && thread.status === 'open').length;
  return (
    <aside className="inspector" aria-label="协作面板">
      <div className="inspector-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'discussion'} className={tab === 'discussion' ? 'is-active' : ''} onClick={() => props.onTab('discussion')}>
          讨论{unread > 0 ? <span className="tab-badge">{unread}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'is-active' : ''} onClick={() => props.onTab('members')}>
          成员与 Agent
        </button>
      </div>
      <div className="inspector-body">
        {tab === 'members' ? (
          <MembersPanel members={props.members} agents={props.agents} onlineIds={props.onlineIds} role={props.role} workspaceRole={props.workspaceRole} onManageMembers={props.onManageMembers} onConfigureAgent={props.onConfigureAgent} onAddAgent={props.onAddAgent} />
        ) : openThread ? (
          <ThreadView
            key={openThread.id}
            thread={openThread}
            suggestions={props.suggestions.filter((suggestion) => suggestion.threadId === openThread.id)}
            versions={props.versions}
            members={props.mentionable}
            viewerId={props.viewerId}
            role={props.role}
            activity={props.activity[openThread.id]}
            identify={props.identify}
            onBack={props.onCloseThread}
            onReply={(body) => actions.reply(openThread.id, body)}
            onResolve={() => void actions.resolve(openThread.id).then(props.onCloseThread)}
            onWithdrawMessage={(message) => void actions.withdrawMessage(message)}
            onLocate={props.onLocate}
            onBatch={(batchId, action) => void actions.batch(batchId, action)}
            suggestionHandlers={{ onAction: actions.suggestion, onRevise: actions.revise, onRestore: (version) => void actions.restore(version) }}
          />
        ) : (
          <>
            {props.composing ? (
              <NewDiscussion members={props.mentionable} agents={props.agents} onSubmit={props.onCreateDiscussion} onCancel={() => props.onCompose(false)} />
            ) : can(props.role, 'comment') ? (
              <button type="button" className="new-discussion-button" onClick={() => props.onCompose(true)}><Icon name="plus" size={14} />对整篇文档发起讨论或任务</button>
            ) : null}
            <ThreadList threads={threads} suggestions={props.suggestions} activity={props.activity} identify={props.identify} onOpen={props.onOpenThread} />
          </>
        )}
      </div>
    </aside>
  );
}
