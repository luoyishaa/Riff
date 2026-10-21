import { colorFor, initials } from '../lib/format.js';

export interface AvatarProps {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  size?: 'sm' | 'md' | 'lg';
  working?: boolean;
  online?: boolean;
}

/** People are round; agents are rounded squares marked "AI" and pulse while working (SPEC §9). */
export function Avatar({ id, name, kind, size = 'md', working = false, online }: AvatarProps): React.ReactElement {
  const label = kind === 'agent' ? `${name}（Agent${working ? '，正在处理' : ''}）` : name;
  return (
    <span className={`avatar avatar-${size} avatar-${kind}${working ? ' is-working' : ''}`} style={{ '--avatar-color': colorFor(id) } as React.CSSProperties} title={label} aria-label={label} role="img">
      {kind === 'agent' ? 'AI' : initials(name)}
      {online === undefined ? null : <span className={`avatar-presence${online ? ' is-online' : ''}`} aria-hidden="true" />}
    </span>
  );
}
