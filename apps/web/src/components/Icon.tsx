/** A small inline icon set (stroke icons, 16px grid); no icon font or library. */
const PATHS = {
  plus: 'M8 3v10M3 8h10',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronDown: 'M4 6l4 4 4-4',
  chevronRight: 'M6 4l4 4-4 4',
  back: 'M10 3L5 8l5 5',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  folder: 'M2 4h4l1.5 1.5H14V13H2z',
  comment: 'M3 3h10v7H7l-3 3v-3H3z',
  check: 'M3 8.5l3 3 7-7',
  history: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5M8 5v3l2 1.5',
  sync: 'M13 6A5 5 0 0 0 3.6 5M3 10a5 5 0 0 0 9.4 1M3 2.5V5h2.5M13 13.5V11h-2.5',
  settings: 'M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  users: 'M6 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 2.3a2.5 2.5 0 0 1 0 4.4M12.5 10c1.3.5 2 1.9 2 4',
  spark: 'M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  inbox: 'M2 9h3.5l1 2h3l1-2H14M2 9l2-6h8l2 6v4H2z',
  link: 'M7 9a3 3 0 0 0 4.2.3l2-2a3 3 0 0 0-4.2-4.2l-1 1M9 7a3 3 0 0 0-4.2-.3l-2 2a3 3 0 0 0 4.2 4.2l1-1',
  logout: 'M6 2.5H3v11h3M10.5 5L13.5 8l-3 3M13.5 8H6',
  undo: 'M5 3L2 6l3 3M2 6h7a4 4 0 0 1 0 8H6',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): React.ReactElement {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
