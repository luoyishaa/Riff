import type { Principal, Role } from '@collab/kernel';
import type { ApprovalDecision, ApprovalPolicy, Suggestion } from './types.js';

const defaultDecision: ApprovalDecision = 'require-approval';

function matches(
  suggestion: Suggestion,
  match: ApprovalPolicy['rules'][number]['match'],
  author: Principal | undefined,
): boolean {
  if (match.authorId !== undefined && match.authorId !== suggestion.authorId) return false;
  const authorKind = author?.kind ?? suggestion.authorKind;
  if (match.authorKind !== undefined && match.authorKind !== authorKind) return false;
  if (match.maxChangedChars !== undefined && suggestion.newText.length > match.maxChangedChars) return false;
  return true;
}

/**
 * Evaluate rules at suggestion creation time. A rule cannot auto-accept a
 * suggestion authored with less than editor effective permission.
 */
export function approvalDecision(
  policy: ApprovalPolicy | undefined,
  suggestion: Suggestion,
  authorEffectiveRole: Role,
  author?: Principal,
): ApprovalDecision {
  if (authorEffectiveRole !== 'editor' && authorEffectiveRole !== 'owner') return defaultDecision;
  if (policy !== undefined && policy.docId !== suggestion.docId) return defaultDecision;
  const rule = policy?.rules.find((candidate) => matches(suggestion, candidate.match, author));
  return rule?.action ?? defaultDecision;
}
