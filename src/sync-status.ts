export type SyncObservation = "configured";

export interface ReadOnlySyncStatus {
  provider: "syncthing";
  observation: SyncObservation;
  canScanVault: true;
  canTransferFiles: true;
  canResolveConflicts: false;
  message: string;
}

/**
 * Describes the plugin's capability boundary without inspecting the vault or
 * contacting a server. Synchronization remains user-controlled until cutover.
 */
export function readOnlySyncStatus(): ReadOnlySyncStatus {
  return {
    provider: "syncthing",
    observation: "configured",
    canScanVault: true,
    canTransferFiles: true,
    canResolveConflicts: false,
    message: "NAS Vault Sync is configured for manual, conflict-preserving synchronization. Keep Syncthing as the only writer until cutover.",
  };
}
