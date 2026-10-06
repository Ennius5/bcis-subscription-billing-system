import { PERMISSIONS, ROLE_DEFINITIONS, ROLE_PERMISSIONS } from "@bcis/shared";
import type { Db } from "./client";
import { permissions, rolePermissions, roles } from "./schema";

/** Upserts all permissions, roles and role-permission links. Returns role code -> role id. */
export async function syncRolesAndPermissions(db: Db): Promise<Map<string, string>> {
  return db.transaction(async (tx) => {
    await tx
      .insert(permissions)
      .values(PERMISSIONS.map((code) => ({ code, description: code })))
      .onConflictDoNothing({ target: permissions.code });

    await tx
      .insert(roles)
      .values(ROLE_DEFINITIONS.map((r) => ({ code: r.code, name: r.name, description: r.description })))
      .onConflictDoNothing({ target: roles.code });

    const permissionId = new Map((await tx.select().from(permissions)).map((p) => [p.code, p.id]));
    const roleId = new Map((await tx.select().from(roles)).map((r) => [r.code, r.id]));

    const links: { roleId: string; permissionId: string }[] = [];
    for (const role of ROLE_DEFINITIONS) {
      for (const code of ROLE_PERMISSIONS[role.code]) {
        const rId = roleId.get(role.code);
        const pId = permissionId.get(code);
        if (!rId || !pId) throw new Error(`Missing role or permission: ${role.code}/${code}`);
        links.push({ roleId: rId, permissionId: pId });
      }
    }
    await tx.insert(rolePermissions).values(links).onConflictDoNothing();

    return roleId;
  });
}