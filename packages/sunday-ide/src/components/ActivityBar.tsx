/**
 * Sunday's activity rail — own icons, own styling.
 * MVP: only Explorer is live; the rest show "soon" and are disabled.
 */
import React from 'react';
import { useIde, RailView } from '../state/ideStore';
import {
  ExplorerIcon,
  SearchIcon,
  BranchIcon,
  AgentSunIcon,
  PuzzleIcon,
  GearIcon,
} from './icons';

const RAIL_ITEMS: { id: RailView; label: string; icon: (p: { size?: number }) => React.ReactNode; live: boolean }[] = [
  { id: 'explorer', label: 'Explorer', icon: ExplorerIcon, live: true },
  { id: 'search', label: 'Search', icon: SearchIcon, live: false },
  { id: 'source', label: 'Source Control', icon: BranchIcon, live: false },
  { id: 'agent', label: 'Sunday Agent', icon: AgentSunIcon, live: false },
  { id: 'extensions', label: 'Extensions', icon: PuzzleIcon, live: false },
];

export function ActivityBar() {
  const { state, dispatch } = useIde();

  return (
    <div className="sunday-rail" role="navigation" aria-label="Sunday activity rail">
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`sunday-rail-btn${state.railView === item.id ? ' active' : ''}`}
          title={item.live ? item.label : `${item.label} — coming soon`}
          disabled={!item.live}
          onClick={() => dispatch({ type: 'SET_RAIL_VIEW', view: item.id })}
        >
          {item.icon({ size: 22 })}
          {!item.live && <span className="soon">SOON</span>}
        </button>
      ))}
      <div className="spacer" />
      <button className="sunday-rail-btn" title="Settings — coming soon" disabled>
        <GearIcon size={22} />
        <span className="soon">SOON</span>
      </button>
    </div>
  );
}
