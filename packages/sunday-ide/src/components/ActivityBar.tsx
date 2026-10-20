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
  DebugIcon,
  OpsShieldIcon,
  MissionTargetIcon,
  GearIcon,
} from './icons';

const RAIL_ITEMS: { id: RailView; label: string; icon: (p: { size?: number }) => React.ReactNode; live: boolean }[] = [
  { id: 'explorer', label: 'Explorer', icon: ExplorerIcon, live: true },
  { id: 'search', label: 'Search', icon: SearchIcon, live: true },
  { id: 'source', label: 'Source Control', icon: BranchIcon, live: true },
  { id: 'agent', label: 'Sunday Agent', icon: AgentSunIcon, live: true },
  { id: 'missions', label: 'Mission Control', icon: MissionTargetIcon, live: true },
  { id: 'extensions', label: 'Extensions', icon: PuzzleIcon, live: true },
  { id: 'debug', label: 'Run & Debug', icon: DebugIcon, live: true },
  { id: 'ops', label: 'Sunday Ops', icon: OpsShieldIcon, live: true },
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
      <button
        className="sunday-rail-btn"
        title="Settings (Ctrl+,)"
        onClick={() => dispatch({ type: 'SET_SETTINGS_OPEN', open: true })}
      >
        <GearIcon size={22} />
      </button>
    </div>
  );
}
