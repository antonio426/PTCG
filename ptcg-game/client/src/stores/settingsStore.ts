import { create } from 'zustand';

/** Battle-screen preferences (zoom / sound). Persisted manually to localStorage rather than
 * via zustand middleware to keep the store shape trivial and the stored JSON stable. */
export type ZoomMode = 'auto' | 100 | 90 | 80 | 70 | 60;

interface SettingsState {
  zoom: ZoomMode;
  sfx: boolean;
  bgm: boolean;
  setZoom: (zoom: ZoomMode) => void;
  setSfx: (on: boolean) => void;
  setBgm: (on: boolean) => void;
}

const STORAGE_KEY = 'ptcg-battle-settings';

function load(): Pick<SettingsState, 'zoom' | 'sfx' | 'bgm'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const zoom: ZoomMode = p.zoom === 'auto' || [100, 90, 80, 70, 60].includes(p.zoom) ? p.zoom : 'auto';
      return { zoom, sfx: p.sfx !== false, bgm: p.bgm === true };
    }
  } catch { /* corrupted storage — fall through to defaults */ }
  return { zoom: 'auto', sfx: true, bgm: false };
}

function save(s: Pick<SettingsState, 'zoom' | 'sfx' | 'bgm'>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* quota/private mode */ }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...load(),
  setZoom: (zoom) => { set({ zoom }); const { sfx, bgm } = get(); save({ zoom, sfx, bgm }); },
  setSfx: (sfx) => { set({ sfx }); const { zoom, bgm } = get(); save({ zoom, sfx, bgm }); },
  setBgm: (bgm) => { set({ bgm }); const { zoom, sfx } = get(); save({ zoom, sfx, bgm }); },
}));
