export const CLOUD_SYNC_ERROR_EVENT = "pdf-translate-reader:cloud-sync-error";
export const CLOUD_SYNC_STATUS_EVENT = "pdf-translate-reader:cloud-sync-status";

export type CloudSyncStatus =
  | "idle"
  | "syncing"
  | "synced"
  | "local-only";

export type CloudSyncStatusDetail = {
  message: string;
  pendingCount: number;
  status: CloudSyncStatus;
  updatedAt: number;
};

let pendingSyncCount = 0;

export function notifyCloudSyncStarted(message = "Syncing changes to cloud.") {
  pendingSyncCount += 1;
  dispatchCloudSyncStatus("syncing", message);
}

export function notifyCloudSyncSuccess(message = "Cloud sync complete.") {
  pendingSyncCount = Math.max(0, pendingSyncCount - 1);
  dispatchCloudSyncStatus(
    pendingSyncCount > 0 ? "syncing" : "synced",
    pendingSyncCount > 0 ? "Syncing changes to cloud." : message,
  );
}

export function notifyCloudSyncError(message = "Saved locally, but cloud sync failed.") {
  pendingSyncCount = Math.max(0, pendingSyncCount - 1);
  dispatchCloudSyncStatus("local-only", message);

  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(CLOUD_SYNC_ERROR_EVENT, {
    detail: {
      message,
    },
  }));
}

export async function runCloudSync<T>(
  task: () => Promise<T>,
  messages: {
    error?: string;
    started?: string;
    success?: string;
  } = {},
) {
  notifyCloudSyncStarted(messages.started);

  try {
    const result = await task();

    notifyCloudSyncSuccess(messages.success);

    return result;
  } catch (error) {
    notifyCloudSyncError(messages.error);
    throw error;
  }
}

export function getCloudSyncStatusDetail(event: Event): CloudSyncStatusDetail {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  const status = isCloudSyncStatus(detail?.status) ? detail.status : "idle";
  const message = typeof detail?.message === "string"
    ? detail.message
    : getDefaultCloudSyncStatusMessage(status);
  const updatedAt = Number.isFinite(detail?.updatedAt) ? Number(detail.updatedAt) : Date.now();
  const pendingCount = Number.isFinite(detail?.pendingCount)
    ? Number(detail.pendingCount)
    : 0;

  return {
    message,
    pendingCount,
    status,
    updatedAt,
  };
}

export function getCloudSyncErrorMessage(event: Event) {
  const detail = event instanceof CustomEvent ? event.detail : undefined;

  return typeof detail?.message === "string"
    ? detail.message
    : "Saved locally, but cloud sync failed.";
}

function dispatchCloudSyncStatus(status: CloudSyncStatus, message: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(CLOUD_SYNC_STATUS_EVENT, {
    detail: {
      message,
      pendingCount: pendingSyncCount,
      status,
      updatedAt: Date.now(),
    } satisfies CloudSyncStatusDetail,
  }));
}

function getDefaultCloudSyncStatusMessage(status: CloudSyncStatus) {
  switch (status) {
    case "syncing":
      return "Syncing changes to cloud.";
    case "synced":
      return "Cloud sync complete.";
    case "local-only":
      return "Saved locally, but cloud sync failed.";
    case "idle":
    default:
      return "Cloud sync is idle.";
  }
}

function isCloudSyncStatus(value: unknown): value is CloudSyncStatus {
  return value === "idle" ||
    value === "syncing" ||
    value === "synced" ||
    value === "local-only";
}
