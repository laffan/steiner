import type { FlowConnectMode } from "../flowchart";

const KEY = "steiner.ui.flowConnectMode";
const DEFAULT_MODE: FlowConnectMode = "closest";

export function loadFlowConnectMode(): FlowConnectMode {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "horizontal" || raw === "closest" ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function saveFlowConnectMode(mode: FlowConnectMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage disabled */
  }
}
