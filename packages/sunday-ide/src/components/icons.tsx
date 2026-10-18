/**
 * Sunday's own icon set — hand-drawn inline SVGs.
 * Deliberately NOT VS Code's codicons.
 */
import React from 'react';

type IconProps = { size?: number; color?: string };

function base({ size = 20, color = 'currentColor' }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

export function SunLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Sunday">
      <circle cx="12" cy="12" r="4.6" fill="#f5b942" />
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI) / 4;
        const x1 = 12 + Math.cos(a) * 6.6;
        const y1 = 12 + Math.sin(a) * 6.6;
        const x2 = 12 + Math.cos(a) * 9.4;
        const y2 = 12 + Math.sin(a) * 9.4;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#f5b942" strokeWidth="2" strokeLinecap="round" />;
      })}
    </svg>
  );
}

export const ExplorerIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2.5h8A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

export const SearchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);

export const BranchIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="6.5" cy="6" r="2.5" />
    <circle cx="6.5" cy="18" r="2.5" />
    <circle cx="17.5" cy="9" r="2.5" />
    <path d="M6.5 8.5v7M17.5 11.5c0 3.5-6 2.5-9.5 4.5" />
  </svg>
);

export const AgentSunIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8" />
  </svg>
);

export const PuzzleIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 4h6v4a2 2 0 1 0 2 2h4v6h-4a2 2 0 1 0-2 2v-2H9v2a2 2 0 1 0-2-2H3v-6h4a2 2 0 1 0 2-2z" />
  </svg>
);

export const DebugIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="13" rx="6" ry="7.5" />
    <path d="M12 5.5V3M9.5 6L8 4M14.5 6L16 4M7 11H3.5M7.5 15l-3 1.5M17 11h3.5M16.5 15l3 1.5M9 13.5h6" />
    <circle cx="12" cy="11" r="0.6" fill="currentColor" />
  </svg>
);

export const GearIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
  </svg>
);

export const ChevronRight = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 14 })}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const ChevronDown = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 14 })}>
    <path d="M5 9l7 7 7-7" />
  </svg>
);

export const PlusIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 16 })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const FolderPlusIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 16 })}>
    <path d="M3 7a1.5 1.5 0 0 1 1.5-1.5h4L10.5 8H19A1.5 1.5 0 0 1 20.5 9.5V11" />
    <path d="M12 13v6M9 16h6" />
  </svg>
);

export const RefreshIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 16 })}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4" />
  </svg>
);

export const CloseIcon = (p: IconProps) => (
  <svg {...base({ ...p, size: p.size ?? 14 })}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const MinIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export const MaxIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <rect x="2.5" y="2.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.6" fill="none" />
  </svg>
);

export const RestoreIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <path d="M4 2.5h5.5v5.5M7.5 2.5v3h-3M4.5 9.5v-3h3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
  </svg>
);

export const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12">
    <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
