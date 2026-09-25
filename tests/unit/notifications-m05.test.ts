import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUser } from "@/lib/auth";
import { fail, ok } from "@/utils/result";

/**
 * M05 notifications: links, badge text, and the service's promises about
 * failure — a count that failed is not zero, and a notification that failed
 * never fails the operation that caused it.
 */

const repo = {
  insert: vi.fn(),
  listRecent: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
  removeForEntity: vi.fn(),
};
const loggerError = vi.fn();

vi.mock("@/modules/notifications/repositories/notifications.repository", () => ({
  notificationsRepository: repo,
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: (...args: unknown[]) => loggerError(...args), warn: vi.fn(), info: vi.fn() },
}));

const { notificationsService } =
  await import("@/modules/notifications/services/notifications.service");
const { notificationHref } = await import("@/modules/notifications/services/notification-types");
const { relativeTime, unreadBadge } =
  await import("@/modules/notifications/components/notification-center");
const { DatabaseError } = await import("@/lib/errors");

const USER: AppUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "a@example.com",
  displayName: "A",
  initials: "A",
  role: "worker",
};
const PROBLEM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  repo.listRecent.mockResolvedValue(ok([]));
  repo.unreadCount.mockResolvedValue(ok(0));
  repo.insert.mockResolvedValue(ok(1));
});

afterEach(() => vi.clearAllMocks());

describe("links come from a closed map", () => {
  it("a problem opens its page", () => {
    expect(notificationHref("issue", PROBLEM)).toBe(`/problems/${PROBLEM}`);
  });

  it("anything else links nowhere", () => {
    expect(notificationHref("account", PROBLEM)).toBeNull();
    expect(notificationHref("issue", "../../admin")).toBeNull();
    expect(notificationHref(null, null)).toBeNull();
  });
});

describe("badge and time text", () => {
  it("hides the badge at zero and caps it at 99+", () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(7)).toBe("7");
    expect(unreadBadge(250)).toBe("99+");
  });

  it("says how long ago, briefly", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    expect(relativeTime("2026-09-25T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-25T11:55:00Z", now)).toBe("5 min ago");
    expect(relativeTime("2026-09-25T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-23T12:00:00Z", now)).toBe("2 d ago");
  });
});

describe("summary", () => {
  it("maps rows to items with links and read state", async () => {
    repo.listRecent.mockResolvedValue(
      ok([
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "problem_assigned",
          title: "Assigned to you: Payment problem",
          body: "one@icloud.com — assigned by Admin",
          entityType: "issue",
          entityId: PROBLEM,
          readAt: null,
          createdAt: new Date("2026-09-25T10:00:00Z"),
        },
      ]),
    );
    repo.unreadCount.mockResolvedValue(ok(1));

    const result = await notificationsService.summary(USER);

    expect(result.ok && result.value).toEqual({
      unreadCount: 1,
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "problem_assigned",
          title: "Assigned to you: Payment problem",
          body: "one@icloud.com — assigned by Admin",
          href: `/problems/${PROBLEM}`,
          read: false,
          createdAt: "2026-09-25T10:00:00.000Z",
        },
      ],
    });
    expect(repo.listRecent).toHaveBeenCalledWith(USER.id, 20);
  });

  it("a failed COUNT fails the summary — it never becomes zero", async () => {
    repo.unreadCount.mockResolvedValue(fail(new DatabaseError("down")));

    const result = await notificationsService.summary(USER);

    expect(result.ok).toBe(false);
  });

  it("a failed LIST fails the summary — it never becomes 'no notifications'", async () => {
    repo.listRecent.mockResolvedValue(fail(new DatabaseError("down")));

    expect((await notificationsService.summary(USER)).ok).toBe(false);
  });

  it("reads only the caller's own rows: the caller's id is the only scope", async () => {
    await notificationsService.summary(USER);

    expect(repo.listRecent.mock.calls[0]?.[0]).toBe(USER.id);
    expect(repo.unreadCount.mock.calls[0]?.[0]).toBe(USER.id);
  });
});

describe("notify", () => {
  it("never notifies the actor, and clips long text", async () => {
    await notificationsService.notify({
      type: "problem_reported",
      recipients: { role: "super_admin" },
      actor: USER,
      title: "T".repeat(500),
      dedupeKey: "k",
    });

    const row = repo.insert.mock.calls[0]?.[0];
    expect(row.excludeUserId).toBe(USER.id);
    expect(row.title).toHaveLength(300);
  });

  it("refuses an empty title or event key", async () => {
    const empty = await notificationsService.notify({
      type: "problem_reported",
      recipients: { role: "super_admin" },
      actor: null,
      title: "  ",
      dedupeKey: "k",
    });

    expect(empty.ok).toBe(false);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("notifyOrWarn logs a failure and never throws or fails its caller", async () => {
    repo.insert.mockResolvedValue(fail(new DatabaseError("down")));

    await expect(
      notificationsService.notifyOrWarn({
        type: "problem_reported",
        recipients: { role: "super_admin" },
        actor: null,
        title: "New problem",
        dedupeKey: "k",
      }),
    ).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledOnce();
  });
});
