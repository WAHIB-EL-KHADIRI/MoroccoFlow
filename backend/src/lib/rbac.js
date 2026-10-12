import { forbidden } from "./errors.js";

export const rolePermissions = Object.freeze({
  owner: ["*"],
  admin: [
    "crm:*",
    "projects:*",
    "quotes:*",
    "finance:*",
    "team:read",
    "team:write",
    "reports:read",
    "settings:read",
    "settings:write",
    "files:*",
  ],
  sales: ["crm:*", "projects:read", "quotes:*", "reports:read", "files:read"],
  project_manager: [
    "crm:read",
    "projects:*",
    "quotes:read",
    "finance:read",
    "reports:read",
    "files:*",
  ],
  finance: ["crm:read", "projects:read", "quotes:*", "finance:*", "reports:read", "files:*"],
  hr: ["team:*", "settings:read"],
  viewer: ["crm:read", "projects:read", "quotes:read", "finance:read", "reports:read", "team:read"],
});

export function can(role, permission) {
  const grants = rolePermissions[role] || [];
  if (grants.includes("*") || grants.includes(permission)) return true;
  const namespace = permission.split(":")[0];
  return grants.includes(`${namespace}:*`);
}

/**
 * Whether `actorRole` may grant `targetRole` to someone, or change an account that holds it.
 * A role can only be handed out by someone who already has every permission it carries,
 * otherwise a role with team:write (hr) could mint an admin and reach CRM and finance.
 * Only the owner can grant or touch the owner-level "*" grant.
 *
 * A wildcard grant "ns:*" is covered by "ns:*" itself or by both "ns:read" and "ns:write",
 * the only two actions the permission table uses.
 */
export function canAssignRole(actorRole, targetRole) {
  if (actorRole === "owner") return true;
  const target = rolePermissions[targetRole];
  if (!target) return false;
  return target.every((grant) => {
    if (grant === "*") return false;
    if (!grant.endsWith(":*")) return can(actorRole, grant);
    const namespace = grant.slice(0, -2);
    return (
      can(actorRole, grant) ||
      (can(actorRole, `${namespace}:read`) && can(actorRole, `${namespace}:write`))
    );
  });
}

export function assertPermission(role, permission) {
  if (!can(role, permission)) throw forbidden();
}
