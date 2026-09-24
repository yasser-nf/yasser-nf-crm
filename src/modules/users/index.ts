/**
 * Users module — public API. ADR-003 Rule 2.
 *
 * The security centre. Owns authorization decisions about people, session
 * management and the activity feed.
 *
 * Repositories are NOT exported. Every operation here carries an authorization
 * check, and exposing a repository would offer a way past it — unlike earlier
 * modules where the repository predates its service, this one has services from
 * the start.
 */
export {
  assignableRoles,
  usersService,
  type UserDetail,
  type UserListEntry,
} from "./services/users.service";
export { sessionsService } from "./services/sessions.service";
export { activityService } from "./services/activity.service";
export { derivePresence, type PresenceState } from "./services/presence";
export {
  deriveInvitationState,
  mayResendInvitation,
  INVITE_LINK_LIFETIME_HOURS,
  type InvitationState,
  type InvitationTimestamps,
} from "./services/invitation-status";

/* Components consumed by app/ page composition. */
export { CreateUserButton, OnlineNow, UsersFilters, UsersTable } from "./components/users-table";
export { CreateUserForm } from "./components/create-user-form";
export { UserDetailView } from "./components/user-detail";
export {
  InvitationBadge,
  PresenceDot,
  RoleBadge,
  UserStatusBadge,
  describeDevice,
} from "./components/user-shared";
export { ResendInviteButton } from "./components/resend-invite-button";

export type { SessionRow } from "./repositories/sessions.repository";
export type { ActivityEntry } from "./repositories/activity.repository";
export type { UserFilter, UserSortField } from "./repositories/users.repository";

export {
  changeRoleSchema,
  changeStatusSchema,
  loginHistoryInsertSchema,
  userInsertSchema,
  userSelectSchema,
  userUpdateSchema,
  type LoginHistoryInsert,
  type UserInsert,
  type UserSelect,
  type UserUpdate,
} from "./validation/user.schema";

export { buildCreateUserSchema, type CreateUserInput } from "./validation/create-user.schema";
