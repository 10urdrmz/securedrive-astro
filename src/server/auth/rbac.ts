/**
 * Roles and permissions. Every business endpoint asks `can(user, permission)`;
 * record-level scope (own / organisation / assigned) is applied inside the query.
 */

export const INTERNAL_ROLES = ["super_admin", "ops_manager", "ops_agent", "support_agent", "finance"] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];
export type Role = InternalRole | "passenger";

export const ROLE_LABELS: Record<Role, string> = {
	super_admin: "Süper admin",
	ops_manager: "Vardiya amiri",
	ops_agent: "Operasyon",
	support_agent: "Destek",
	finance: "Finans",
	passenger: "Yolcu",
};

export type Permission =
	| "ops.access"
	| "catalog.read"
	| "catalog.write"
	| "tariffs.write"
	| "settings.write"
	| "users.manage"
	| "audit.read";

const GRANTS: Record<Role, Permission[]> = {
	super_admin: ["ops.access", "catalog.read", "catalog.write", "tariffs.write", "settings.write", "users.manage", "audit.read"],
	ops_manager: ["ops.access", "catalog.read", "catalog.write", "tariffs.write"],
	ops_agent: ["ops.access", "catalog.read"],
	support_agent: ["ops.access", "catalog.read"],
	finance: ["ops.access", "catalog.read"],
	passenger: [],
};

export interface SessionUser {
	id: string;
	name: string;
	email: string | null;
	roles: Role[];
}

export function can(user: SessionUser | null | undefined, permission: Permission): boolean {
	return !!user && user.roles.some((role) => GRANTS[role]?.includes(permission));
}

export function isInternalRole(role: string): role is InternalRole {
	return (INTERNAL_ROLES as readonly string[]).includes(role);
}
