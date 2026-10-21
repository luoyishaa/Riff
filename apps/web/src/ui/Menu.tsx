import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}
export interface MenuSection { title?: string | undefined; items: MenuItem[] }

export interface MenuProps {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  sections: MenuSection[];
  header?: ReactNode;
  align?: 'start' | 'end';
  label: string;
}

/** A dropdown menu: arrow keys move, Esc and outside clicks close, focus returns to the trigger. */
export function Menu({ trigger, sections, header, align = 'start', label }: MenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      (list.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])'))?.focus();
    });
    const onPointer = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      root.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const move = (event: React.KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={root} className="menu-root">
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open ? (
        <div ref={list} className={`menu-popover align-${align}`} role="menu" aria-label={label} onKeyDown={move}>
          {header ? <div className="menu-header">{header}</div> : null}
          {sections.filter((section) => section.items.length > 0).map((section, index) => (
            <div className="menu-section" key={section.title ?? index}>
              {section.title ? <div className="menu-section-title">{section.title}</div> : null}
              {section.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
                  {...(item.selected === undefined ? {} : { 'aria-checked': item.selected })}
                  className={`menu-item${item.selected ? ' is-selected' : ''}${item.danger ? ' is-danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => { setOpen(false); item.onSelect(); }}
                >
                  <span className="menu-item-label">{item.label}</span>
                  {item.hint ? <span className="menu-item-hint">{item.hint}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
