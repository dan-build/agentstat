// src/ui/StatusIcon.tsx — one glyph per status, so status never relies on color.
import type { AgentStatus } from '../types';

export const StatusIcon = ({ status }: { status: AgentStatus }) => {
  const common = {
    width: 10,
    height: 10,
    viewBox: '0 0 10 10',
    'aria-hidden': true,
    focusable: false,
  } as const;
  switch (status) {
    case 'thinking':
      return (
        <svg {...common} fill="currentColor">
          <circle cx="1.5" cy="5" r="1.1" />
          <circle cx="5" cy="5" r="1.1" />
          <circle cx="8.5" cy="5" r="1.1" />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.2 1h5.6M2.2 9h5.6M2.8 1.2 5 5l2.2-3.8M2.8 8.8 5 5l2.2 3.8" />
        </svg>
      );
    case 'stuck':
      return (
        <svg {...common} fill="currentColor">
          <rect x="2" y="1.5" width="2" height="7" rx="0.6" />
          <rect x="6" y="1.5" width="2" height="7" rx="0.6" />
        </svg>
      );
    case 'complete':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.8 5.3 4 7.4 8.2 2.8" />
        </svg>
      );
    case 'hallucinating':
      return (
        <svg {...common} fill="currentColor">
          <path d="M5 .8 9.4 8.8H.6z" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="currentColor">
          <circle cx="5" cy="5" r="3" />
        </svg>
      );
  }
};
