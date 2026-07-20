import { forbidden } from "./errors.js";

export const rolePermissions = Object.freeze({
  owner: ["*"],
  admin: [
    "crm:*",
    "projects:*",
    "finance:*",
    "team:read",
    "team:write",
    "reports:read",
    "settings:read",
    "settings:write",
    "files:*",
  ],
  sales: ["crm:*", "projects:read", "finance:quotes", "reports:read", "files:read"],
  project_manager: ["crm:read", "projects:*", "finance:read", "reports:read", "files:*"],
  finance: ["crm:read", "projects:read", "finance:*", "reports:read", "files:*"],
  hr: ["team:*", "settings:read"],
  viewer: ["crm:read", "projects:read", "finance:read", "reports:read", "team:read"],
});

export function can(role, permission) {
  const grants = rolePermissions[role] || [];
  if (grants.includes("*") || grants.includes(permission)) return true;
  const namespace = permission.split(":")[0];
  return grants.includes(`${namespace}:*`);
}

export function assertPermission(role, permission) {
  if (!can(role, permission)) throw forbidden();
}
