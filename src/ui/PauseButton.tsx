// src/ui/PauseButton.tsx — freezes the view; data keeps buffering.

export function PauseButton({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
  return (
    <div className="agentstat-pause">
      <button type="button" className="agentstat-btn agentstat-surface" aria-pressed={paused} onClick={onToggle}>
        <span className="agentstat-icon" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" data-on={!paused}>
            <rect x="2.5" y="2" width="2.5" height="8" rx="0.75" />
            <rect x="7" y="2" width="2.5" height="8" rx="0.75" />
          </svg>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" data-on={paused}>
            {/* Nudged right of center: a triangle's visual mass sits left. */}
            <path d="M3.75 2.2v7.6a.6.6 0 0 0 .9.52l6.1-3.8a.6.6 0 0 0 0-1.04l-6.1-3.8a.6.6 0 0 0-.9.52Z" />
          </svg>
        </span>
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
