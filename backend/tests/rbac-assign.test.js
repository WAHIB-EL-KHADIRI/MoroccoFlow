import { describe, expect, it } from "vitest";
import { canAssignRole, rolePermissions } from "../src/lib/rbac.js";

const assignable = (actor) =>
  Object.keys(rolePermissions)
    .filter((target) => canAssignRole(actor, target))
    .sort();

describe("canAssignRole", () => {
  it("lets the owner grant every role, including owner", () => {
    expect(assignable("owner")).toEqual(Object.keys(rolePermissions).sort());
  });

  it("lets an admin grant every role except owner", () => {
    expect(assignable("admin")).toEqual(
      ["admin", "finance", "hr", "project_manager", "sales", "viewer"].sort(),
    );
  });

  it("never lets anyone but the owner grant or touch the owner role", () => {
    for (const actor of Object.keys(rolePermissions).filter((role) => role !== "owner")) {
      expect(canAssignRole(actor, "owner"), actor).toBe(false);
    }
  });

  it("stops hr from minting an admin or any role with business access", () => {
    expect(assignable("hr")).toEqual(["hr"]);
  });

  it("lets nobody grant a role that carries a permission they lack", () => {
    for (const actor of Object.keys(rolePermissions)) {
      for (const target of assignable(actor)) {
        if (actor === "owner") continue;
        for (const grant of rolePermissions[target]) {
          const covered = grant.endsWith(":*")
            ? canAssignRoleGrantCovered(actor, grant)
            : rolePermissions[actor].some(
                (own) => own === grant || (own.endsWith(":*") && grant.startsWith(own.slice(0, -1))),
              );
          expect(covered, `${actor} -> ${target} (${grant})`).toBe(true);
        }
      }
    }
  });

  it("refuses unknown roles", () => {
    expect(canAssignRole("admin", "superadmin")).toBe(false);
    expect(canAssignRole("nobody", "viewer")).toBe(false);
  });
});

/** Independent restatement of the wildcard rule, so the property test is not circular. */
function canAssignRoleGrantCovered(actor, grant) {
  const own = rolePermissions[actor];
  const namespace = grant.slice(0, -2);
  const has = (permission) =>
    own.includes("*") || own.includes(permission) || own.includes(`${namespace}:*`);
  return has(grant) || (has(`${namespace}:read`) && has(`${namespace}:write`));
}
