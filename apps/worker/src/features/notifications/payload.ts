import type {
  ConnectorId,
  NotificationPreferences,
  SyncNotificationStatus,
} from "@taiwan-fin-hub/core";
import { connectorCatalog } from "@taiwan-fin-hub/core";

export type SyncNotificationEvent = {
  connectorId: ConnectorId;
  status: SyncNotificationStatus;
};

export type PushNotificationPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

export function syncNotificationPayload(
  event: SyncNotificationEvent,
): PushNotificationPayload {
  const connector = connectorCatalog[event.connectorId].title;
  if (event.status === "success") {
    return {
      title: "同步完成",
      body: `${connector}已完成排程同步，開啟 App 查看結果。`,
      url: "/#/overview",
      tag: `sync-${event.connectorId}-success`,
    };
  }

  if (event.status === "needs_user_action") {
    return {
      title: "需要你的操作",
      body: `${connector}需要重新驗證，請開啟 App 處理。`,
      url: "/#/data-sources",
      tag: `sync-${event.connectorId}-needs-action`,
    };
  }

  return {
    title: "同步失敗",
    body: `${connector}同步失敗，請開啟 App 查看狀態。`,
    url: "/#/data-sources",
    tag: `sync-${event.connectorId}-failed`,
  };
}

export function scheduledSyncSummaryPayload(
  events: SyncNotificationEvent[],
): PushNotificationPayload {
  const success = events.filter((event) => event.status === "success").length;
  const failed = events.filter((event) => event.status === "failed").length;
  const needsUserAction = events.filter(
    (event) => event.status === "needs_user_action",
  ).length;
  const status = summaryStatus(events);

  if (status === "success") {
    return {
      title: "同步完成",
      body: "每日同步已完成，開啟 App 查看結果。",
      url: "/#/overview",
      tag: "sync-default-schedule-success",
    };
  }

  const counts = [
    success > 0 ? `成功 ${success}` : null,
    failed > 0 ? `失敗 ${failed}` : null,
    needsUserAction > 0 ? `需處理 ${needsUserAction}` : null,
  ].filter((count): count is string => count !== null);

  return {
    title:
      status === "needs_user_action"
        ? "同步完成，需要你的操作"
        : "同步完成，部分失敗",
    body: `預設排程同步完成：${counts.join("、")}。`,
    url: "/#/data-sources",
    tag:
      status === "needs_user_action"
        ? "sync-default-schedule-needs-action"
        : "sync-default-schedule-failed",
  };
}

export function summaryStatus(
  events: SyncNotificationEvent[],
): SyncNotificationStatus {
  if (events.some((event) => event.status === "needs_user_action")) {
    return "needs_user_action";
  }
  if (events.some((event) => event.status === "failed")) return "failed";
  return "success";
}

export function shouldNotify(
  preferences: NotificationPreferences,
  status: SyncNotificationStatus,
) {
  if (status === "success") return preferences.success;
  if (status === "needs_user_action") return preferences.needsUserAction;
  return preferences.failed;
}
