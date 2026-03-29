interface ToolbarMenuProps {
  isOpen: boolean;
  canDeleteNote: boolean;
  canOpenHistory: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
  onDeleteNote: () => void;
  onOpenHistory: () => void;
  onOpenAI: () => void;
  onOpenSettings: () => void;
}

export function ToolbarMenu({ isOpen, canDeleteNote, canOpenHistory, menuRef, onToggle, onDeleteNote, onOpenHistory, onOpenAI, onOpenSettings }: ToolbarMenuProps) {
  return (
    <div className="toolbar-menu-shell" ref={menuRef}>
      <button
        type="button"
        className="settings-trigger"
        aria-label="Open menu"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span />
        <span />
        <span />
      </button>

      {isOpen ? (
        <div className="toolbar-menu-dropdown" role="menu" aria-label="Workspace menu">
          <button
            type="button"
            className="toolbar-menu-item"
            role="menuitem"
            data-disabled={canDeleteNote ? 'false' : 'true'}
            onMouseDown={(event) => {
              event.preventDefault();
              onDeleteNote();
            }}
          >
            Delete Note
          </button>
          <button
            type="button"
            className="toolbar-menu-item"
            role="menuitem"
            disabled={!canOpenHistory}
            onClick={onOpenHistory}
          >
            View history
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            Export to Markdown
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            See properties
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" disabled>
            Reindex for AI
          </button>
          <button type="button" className="toolbar-menu-item" role="menuitem" onClick={onOpenAI}>
            <span>AI chat</span>
            <span className="toolbar-menu-shortcut" title="Cmd+Shift+A">
              Cmd+Shift+A
            </span>
          </button>
          <button type="button" className="toolbar-menu-item toolbar-menu-item-settings" role="menuitem" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      ) : null}
    </div>
  );
}
