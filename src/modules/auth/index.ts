/**
 * Auth module — public API.
 *
 * ADR-003 Rule 2: this file is the module contract. Everything not exported
 * here is internal and must not be imported from outside the module. ESLint
 * blocks deep imports into `@/modules/auth/*`.
 *
 * The service is exported for cross-module use; the repository layer (when this
 * module gains one) never will be.
 */
export { AuthCallbackFragment } from "./components/auth-callback-fragment";
export { ChangePasswordForm } from "./components/change-password-form";
export { SetPasswordForm } from "./components/set-password-form";
export { LoginForm } from "./components/login-form";
export { useChangePassword } from "./hooks/use-change-password";
export { useLogin } from "./hooks/use-login";
export { useLogout } from "./hooks/use-logout";
export { authService } from "./services/auth.service";
export {
  buildChangePasswordSchema,
  type ChangePasswordInput,
} from "./validation/change-password.schema";
export { loginSchema, type LoginInput } from "./validation/login.schema";
export { buildSetPasswordSchema, type SetPasswordInput } from "./validation/set-password.schema";
