// ===========================================================================
// chrome.storage.local ラッパ。スイープ状態・結果・dev キャプチャを永続化し、
// MV3 サービスワーカーが停止/再起動しても再開できるようにする。
// ===========================================================================

import type {
  RawCapture,
  ResultRow,
  SearchJob,
  SweepConfig,
  SweepRunState,
} from '../core/types';

export interface PersistedSweep {
  config: SweepConfig;
  jobs: SearchJob[];
  state: SweepRunState;
  cursor: number; // 次に実行するジョブの index
}

const KEYS = {
  sweep: 'sweep',
  rows: 'rows',
  devCapture: 'devCapture',
  captures: 'devCaptures',
} as const;

const MAX_DEV_CAPTURES = 100; // リングバッファ上限

export async function saveSweep(sweep: PersistedSweep | null): Promise<void> {
  await chrome.storage.local.set({ [KEYS.sweep]: sweep });
}

export async function loadSweep(): Promise<PersistedSweep | null> {
  const v = await chrome.storage.local.get(KEYS.sweep);
  return (v[KEYS.sweep] as PersistedSweep) ?? null;
}

export async function saveRows(rows: ResultRow[]): Promise<void> {
  await chrome.storage.local.set({ [KEYS.rows]: rows });
}

export async function loadRows(): Promise<ResultRow[]> {
  const v = await chrome.storage.local.get(KEYS.rows);
  return (v[KEYS.rows] as ResultRow[]) ?? [];
}

export async function appendRows(newRows: ResultRow[]): Promise<ResultRow[]> {
  const existing = await loadRows();
  const merged = [...existing, ...newRows];
  await saveRows(merged);
  return merged;
}

export async function clearRows(): Promise<void> {
  await saveRows([]);
}

export async function getDevCapture(): Promise<boolean> {
  const v = await chrome.storage.local.get(KEYS.devCapture);
  return Boolean(v[KEYS.devCapture]);
}

export async function setDevCapture(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [KEYS.devCapture]: enabled });
}

export async function recordRawCapture(capture: RawCapture): Promise<void> {
  const v = await chrome.storage.local.get(KEYS.captures);
  const list = ((v[KEYS.captures] as RawCapture[]) ?? []).slice(-(MAX_DEV_CAPTURES - 1));
  list.push(capture);
  await chrome.storage.local.set({ [KEYS.captures]: list });
}

export async function loadRawCaptures(): Promise<RawCapture[]> {
  const v = await chrome.storage.local.get(KEYS.captures);
  return (v[KEYS.captures] as RawCapture[]) ?? [];
}

export async function clearRawCaptures(): Promise<void> {
  await chrome.storage.local.set({ [KEYS.captures]: [] });
}
