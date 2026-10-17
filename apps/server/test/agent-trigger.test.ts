import { describe, expect, it } from 'vitest';
import { agentTriggerTargets } from '../src/agent-trigger.js';

describe('agent trigger targets', () => {
  const isAgent = (id: string): boolean => id.startsWith('agent-');

  it('includes the assigned task agent even without an @mention', () => {
    expect(agentTriggerTargets({
      thread: { kind: 'task', agentId: 'agent-polisher' },
      mentioned: [],
      participated: [],
      isAgent,
    })).toEqual(['agent-polisher']);
  });

  it('keeps explicit mentions and prior participants unique', () => {
    expect(agentTriggerTargets({
      thread: { kind: 'discussion', agentId: undefined },
      mentioned: ['agent-reviewer', 'human-alice'],
      participated: ['agent-reviewer', 'agent-polisher'],
      isAgent,
    })).toEqual(['agent-reviewer', 'agent-polisher']);
  });

  it('does not assign a discussion to an agent from an unrelated field', () => {
    expect(agentTriggerTargets({
      thread: { kind: 'discussion', agentId: 'agent-polisher' },
      mentioned: [],
      participated: [],
      isAgent,
    })).toEqual([]);
  });
});
