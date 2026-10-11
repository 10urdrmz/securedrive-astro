/**
 * Roles and permissions. Every business endpoint asks `can(user, permission)`;
 * record-level scope (own / organisation / assigned) is applied inside the query.
 */

export const INTERNAL_ROLES = ["super_admin", "ops_manager", "ops_agent", "support_agent", "finance"] as const;
export type InternalRole = (typeof INTERNAL_ROLES)[number];
/** Partner fleet staff; they only ever see their own organisation's jobs. */
export const PARTNER_ROLES = ["carrier_admin"] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];
/** Company (kurumsal) staff: admins also manage the company's logins. */
export const COMPANY_ROLES = ["company_admin", "company_booker"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
/** Agency and hotel staff: admins also manage the agency's logins. */
export const AGENCY_ROLES = ["agency_admin", "agency_staff"] as const;
export type AgencyRole = (typeof AGENCY_ROLES)[number];
export type Role = InternalRole | PartnerRole | CompanyRole | AgencyRole | "passenger";

export const ROLE_LABELS: Record<Role, string> = {
	super_admin: "Süper admin",
	ops_manager: "Vardiya amiri",
	ops_agent: "Operasyon",
	support_agent: "Destek",
	finance: "Finans",
	carrier_admin: "Partner yöneticisi",
	company_admin: "Kurumsal yönetici",
	company_booker: "Kurumsal rezervasyon yetkilisi",
	agency_admin: "Acente yöneticisi",
	agency_staff: "Acente personeli",
	passenger: "Yolcu",
};

export type Permission =
	| "ops.access"
	| "catalog.read"
	| "catalog.write"
	| "tariffs.write"
	| "settings.write"
	| "users.manage"
	| "audit.read"
	| "bookings.read"
	| "bookings.write"
	| "drivers.manage"
	| "payments.write"
	| "partners.manage"
	| "settlements.manage"
	| "partner.access"
	| "companies.manage"
	| "company.access"
	| "company.manage"
	| "agencies.manage"
	| "agency.access"
	| "agency.manage"
	| "reports.read";

const GRANTS: Record<Role, Permission[]> = {
	super_admin: [
		"ops.access",
		"catalog.read",
		"catalog.write",
		"tariffs.write",
		"settings.write",
		"users.manage",
		"audit.read",
		"bookings.read",
		"bookings.write",
		"drivers.manage",
		"payments.write",
		"partners.manage",
		"settlements.manage",
		"companies.manage",
		"agencies.manage",
		"reports.read",
	],
	ops_manager: ["ops.access", "catalog.read", "catalog.write", "tariffs.write", "bookings.read", "bookings.write", "drivers.manage", "payments.write", "partners.manage", "settlements.manage", "companies.manage", "agencies.manage", "reports.read"],
	ops_agent: ["ops.access", "catalog.read", "bookings.read", "bookings.write"],
	support_agent: ["ops.access", "catalog.read", "bookings.read"],
	finance: ["ops.access", "catalog.read", "bookings.read", "payments.write", "settlements.manage", "reports.read"],
	carrier_admin: ["partner.access"],
	company_admin: ["company.access", "company.manage"],
	company_booker: ["company.access"],
	agency_admin: ["agency.access", "agency.manage"],
	agency_staff: ["agency.access"],
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
