/**
 * Talep Yönetimi: the operations team's working view of incoming requests.
 *
 * The inquiries collection is still editable entry by entry under Gelen Talepler,
 * but that editor is built for publishing content. This board shows every request
 * in one table with its trip details, lets the team move it through the steps
 * (Yeni → İletişime geçildi → Fiyat verildi → Rezervasyon onaylandı → Kapandı) in
 * one click, keep notes, and call or message the customer.
 */
import { Banner, Button, Input, Loader } from "@cloudflare/kumo";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API = "/_emdash/api/plugins/inquiries";
const REFRESH_MS = 60_000;

const STATUSES = [
	{ value: "new", label: "Yeni", color: "blue" },
	{ value: "contacted", label: "İletişime geçildi", color: "orange" },
	{ value: "quoted", label: "Fiyat verildi", color: "purple" },
	{ value: "booked", label: "Rezervasyon onaylandı", color: "green" },
	{ value: "closed", label: "Kapandı", color: "neutral" },
] as const;
type Status = (typeof STATUSES)[number]["value"];

const KINDS = [
	{ value: "transfer", label: "Transfer" },
	{ value: "contact", label: "İletişim" },
	{ value: "corporate", label: "Kurumsal" },
] as const;

interface Details {
	from?: string;
	to?: string;
	date?: string;
	time?: string;
	passengers?: number;
	luggage?: number;
	vehicle?: string;
	flight?: string;
	return_trip?: boolean;
}

interface Inquiry {
	id: string;
	/** Request number shown to the customer, e.g. "SD-2610-0042". */
	reference: string;
	kind: string;
	status: Status;
	name?: string;
	phone?: string;
	email?: string;
	company?: string;
	message?: string;
	details?: Details | string | null;
	locale?: string;
	notes?: string;
	submittedAt?: string;
}

const statusOf = (value: string) => STATUSES.find((s) => s.value === value) ?? STATUSES[0];
const kindLabel = (value: string) => KINDS.find((k) => k.value === value)?.label ?? value;

function detailsOf(item: Inquiry): Details {
	if (!item.details) return {};
	if (typeof item.details !== "string") return item.details;
	try {
		return JSON.parse(item.details) as Details;
	} catch {
		return {};
	}
}

const dateTime = new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" });
const dayOnly = new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeZone: "UTC" });

function when(value?: string): string {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? dateTime.format(date) : "";
}

/** Travel dates are plain calendar days ("2026-11-05"); format them without shifting time zones. */
function travelDay(details: Details): string {
	if (!details.date) return "";
	const date = new Date(`${details.date}T00:00:00Z`);
	const day = Number.isNaN(date.getTime()) ? details.date : dayOnly.format(date);
	return [day, details.time].filter(Boolean).join(" · ");
}

/** Digits only, as wa.me expects. */
const whatsapp = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "")}`;

/** A tinted pill with normal text colour, so it stays readable for every step in light and dark mode. */
const badge = (color: string): React.CSSProperties => ({
	display: "inline-block",
	padding: "2px 10px",
	borderRadius: 999,
	fontSize: 12,
	fontWeight: 600,
	whiteSpace: "nowrap",
	color: "var(--text-color-kumo-default)",
	background: `color-mix(in srgb, var(--color-kumo-badge-${color}) 22%, transparent)`,
	border: `1px solid var(--color-kumo-badge-${color})`,
});

const control: React.CSSProperties = {
	font: "inherit",
	color: "inherit",
	background: "var(--color-kumo-control)",
	border: "1px solid var(--color-kumo-line)",
	borderRadius: 8,
	padding: "6px 10px",
};

function StatusSelect(props: { value: Status; disabled?: boolean; onChange: (value: Status) => void }) {
	return (
		<select
			aria-label="Durum"
			value={props.value}
			disabled={props.disabled}
			style={control}
			onClick={(event) => event.stopPropagation()}
			onChange={(event) => props.onChange(event.target.value as Status)}
		>
			{STATUSES.map((s) => (
				<option key={s.value} value={s.value}>
					{s.label}
				</option>
			))}
		</select>
	);
}

function Row(props: { label: string; children?: React.ReactNode }) {
	if (!props.children) return null;
	return (
		<div className="flex gap-3 py-2 border-b border-kumo-line text-sm">
			<span className="text-kumo-subtle" style={{ width: 120, flexShrink: 0 }}>
				{props.label}
			</span>
			<span className="flex-1 min-w-0" style={{ overflowWrap: "anywhere" }}>
				{props.children}
			</span>
		</div>
	);
}

function BoardPage() {
	const [items, setItems] = React.useState<Inquiry[] | null>(null);
	const [truncated, setTruncated] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [loading, setLoading] = React.useState(false);
	const [status, setStatus] = React.useState<Status | "all">("all");
	const [kind, setKind] = React.useState<string>("all");
	const [query, setQuery] = React.useState("");
	const [openId, setOpenId] = React.useState<string | null>(null);
	const [notes, setNotes] = React.useState("");
	const [saving, setSaving] = React.useState<string | null>(null);

	const load = React.useCallback(async () => {
		setLoading(true);
		try {
			const response = await apiFetch(`${API}/board`);
			const data = await parseApiResponse<{ items: Inquiry[]; truncated: boolean }>(response);
			setItems(data.items);
			setTruncated(data.truncated);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Talepler yüklenemedi");
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		void load();
		const timer = window.setInterval(() => void load(), REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [load]);

	const open = items?.find((item) => item.id === openId) ?? null;
	React.useEffect(() => {
		setNotes(open?.notes ?? "");
		// Only reset the draft when another request is opened, not on every refresh.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openId]);

	const change = async (id: string, changes: { status?: Status; notes?: string }) => {
		setSaving(id);
		try {
			const response = await apiFetch(`${API}/update`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, ...changes }),
			});
			const result = await parseApiResponse<{ ok: boolean; error?: string }>(response);
			if (!result.ok) throw new Error(result.error ?? "Kaydedilemedi");
			setItems((current) => current?.map((item) => (item.id === id ? { ...item, ...changes } : item)) ?? current);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Kaydedilemedi");
		} finally {
			setSaving(null);
		}
	};

	const all = items ?? [];
	const needle = query.trim().toLocaleLowerCase("tr");
	const matching = all.filter((item) => {
		if (kind !== "all" && item.kind !== kind) return false;
		if (!needle) return true;
		const d = detailsOf(item);
		return [item.reference, item.name, item.phone, item.email, item.company, d.from, d.to, d.flight]
			.filter(Boolean)
			.some((text) => String(text).toLocaleLowerCase("tr").includes(needle));
	});
	const visible = status === "all" ? matching : matching.filter((item) => item.status === status);
	const count = (value: Status) => matching.filter((item) => item.status === value).length;

	const tab = (active: boolean): React.CSSProperties => ({
		...control,
		cursor: "pointer",
		textAlign: "start",
		background: active ? "var(--color-kumo-tint)" : "var(--color-kumo-base)",
		borderColor: active ? "var(--color-kumo-brand)" : "var(--color-kumo-line)",
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between gap-4 flex-wrap">
				<div>
					<h1 className="text-2xl font-bold">Talep Yönetimi</h1>
					<p className="text-sm text-kumo-subtle">
						Sitedeki transfer, iletişim ve kurumsal formlarından gelen talepler. Liste dakikada bir yenilenir.
					</p>
				</div>
				<Button variant="secondary" onClick={() => void load()} loading={loading}>
					Yenile
				</Button>
			</div>

			{error && <Banner variant="error" title="İşlem tamamlanamadı" description={error} />}
			{truncated && (
				<Banner
					variant="alert"
					title="Yalnızca en yeni 500 talep gösteriliyor"
					description="Daha eski talepler için Gelen Talepler listesini kullanın."
				/>
			)}

			<div className="flex gap-3 flex-wrap">
				<button type="button" style={tab(status === "all")} onClick={() => setStatus("all")}>
					<div className="text-xs text-kumo-subtle">Tümü</div>
					<div className="text-xl font-bold tabular-nums">{matching.length}</div>
				</button>
				{STATUSES.map((s) => (
					<button key={s.value} type="button" style={tab(status === s.value)} onClick={() => setStatus(s.value)}>
						<div className="text-xs text-kumo-subtle">{s.label}</div>
						<div className="text-xl font-bold tabular-nums">{count(s.value)}</div>
					</button>
				))}
			</div>

			<div className="flex items-center gap-3 flex-wrap">
				<select aria-label="Form türü" value={kind} style={control} onChange={(event) => setKind(event.target.value)}>
					<option value="all">Tüm formlar</option>
					{KINDS.map((k) => (
						<option key={k.value} value={k.value}>
							{k.label}
						</option>
					))}
				</select>
				<div style={{ width: "min(420px, 100%)" }}>
					<Input
						aria-label="Ara"
						placeholder="Talep no, ad, telefon, e-posta, güzergâh veya uçuş no ara"
						value={query}
						className="w-full"
						onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
					/>
				</div>
			</div>

			{items === null && !error && (
				<div className="flex items-center gap-2">
					<Loader size="sm" />
					<span className="text-sm text-kumo-subtle">Talepler yükleniyor…</span>
				</div>
			)}

			{items !== null && visible.length === 0 && (
				<p className="text-sm text-kumo-subtle py-3">Bu filtreye uyan talep yok.</p>
			)}

			{visible.length > 0 && (
				<div className="overflow-x-auto border border-kumo-line rounded-lg bg-kumo-base">
					<table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
						<thead>
							<tr className="text-left text-xs uppercase tracking-wide text-kumo-subtle">
								{["Talep no", "Gönderim", "Müşteri", "Talep", "Yolculuk", "Durum", ""].map((heading) => (
									<th key={heading} className="px-4 py-3 border-b border-kumo-line font-medium whitespace-nowrap">
										{heading}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{visible.map((item) => {
								const d = detailsOf(item);
								const selected = item.id === openId;
								return (
									<tr
										key={item.id}
										className="cursor-pointer align-top"
										style={{ background: selected ? "var(--color-kumo-tint)" : undefined }}
										onClick={() => setOpenId(selected ? null : item.id)}
									>
										<td className="px-4 py-3 border-b border-kumo-line whitespace-nowrap font-semibold tabular-nums" dir="ltr">
											{item.reference}
										</td>
										<td className="px-4 py-3 border-b border-kumo-line whitespace-nowrap text-kumo-subtle">
											{when(item.submittedAt)}
										</td>
										<td className="px-4 py-3 border-b border-kumo-line">
											<div className="font-semibold">{item.name}</div>
											<div className="text-kumo-subtle" dir="ltr">
												{item.phone}
											</div>
											{item.company && <div className="text-kumo-subtle">{item.company}</div>}
										</td>
										<td className="px-4 py-3 border-b border-kumo-line">
											<div className="text-xs text-kumo-subtle">{kindLabel(item.kind)}</div>
											{item.kind === "transfer" ? (
												<div className="font-medium">
													{d.from} → {d.to}
												</div>
											) : (
												<div style={{ maxWidth: 320 }} className="truncate">
													{item.message}
												</div>
											)}
										</td>
										<td className="px-4 py-3 border-b border-kumo-line">
											<div>{travelDay(d)}</div>
											<div className="text-kumo-subtle">
												{[d.passengers && `${d.passengers} yolcu`, d.vehicle, d.flight, d.return_trip && "Dönüş dahil"]
													.filter(Boolean)
													.join(" · ")}
											</div>
										</td>
										<td className="px-4 py-3 border-b border-kumo-line whitespace-nowrap">
											<StatusSelect
												value={statusOf(item.status).value}
												disabled={saving === item.id}
												onChange={(value) => void change(item.id, { status: value })}
											/>
										</td>
										<td className="px-4 py-3 border-b border-kumo-line whitespace-nowrap text-right">
											{item.phone && (
												<span className="flex gap-3" onClick={(event) => event.stopPropagation()}>
													<a className="text-kumo-link underline" href={`tel:${item.phone.replace(/[^\d+]/g, "")}`}>
														Ara
													</a>
													<a className="text-kumo-link underline" href={whatsapp(item.phone)} target="_blank" rel="noreferrer">
														WhatsApp
													</a>
												</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{open && (
				<aside
					className="fixed inset-y-0 right-0 z-50 h-full overflow-y-auto bg-kumo-base border border-kumo-line shadow-lg p-6 space-y-4"
					style={{ width: "min(440px, 100vw)" }}
					aria-label="Talep ayrıntıları"
				>
					<div className="flex items-center justify-between gap-3">
						<span style={badge(statusOf(open.status).color)}>{statusOf(open.status).label}</span>
						<Button variant="secondary" onClick={() => setOpenId(null)}>
							Kapat
						</Button>
					</div>
					<div>
						<div className="text-xs text-kumo-subtle">
							<strong dir="ltr">{open.reference}</strong> · {kindLabel(open.kind)} · {when(open.submittedAt)}
						</div>
						<h2 className="text-xl font-bold">{open.name}</h2>
					</div>

					<div>
						<Row label="Telefon">
							{open.phone && (
								<>
									<a className="text-kumo-link underline" dir="ltr" href={`tel:${open.phone.replace(/[^\d+]/g, "")}`}>
										{open.phone}
									</a>{" "}
									·{" "}
									<a className="text-kumo-link underline" href={whatsapp(open.phone)} target="_blank" rel="noreferrer">
										WhatsApp
									</a>
								</>
							)}
						</Row>
						<Row label="E-posta">
							{open.email && (
								<a className="text-kumo-link underline" dir="ltr" href={`mailto:${open.email}`}>
									{open.email}
								</a>
							)}
						</Row>
						<Row label="Firma">{open.company}</Row>
						{(() => {
							const d = detailsOf(open);
							return (
								<>
									<Row label="Nereden">{d.from}</Row>
									<Row label="Nereye">{d.to}</Row>
									<Row label="Yolculuk">{travelDay(d)}</Row>
									<Row label="Uçuş no">{d.flight}</Row>
									<Row label="Yolcu / bagaj">
										{(d.passengers || d.luggage) &&
											[d.passengers && `${d.passengers} yolcu`, d.luggage && `${d.luggage} bagaj`].filter(Boolean).join(" · ")}
									</Row>
									<Row label="Araç">{d.vehicle}</Row>
									<Row label="Dönüş">{d.return_trip ? "Dönüş transferi de isteniyor" : undefined}</Row>
								</>
							);
						})()}
						<Row label="Site dili">{open.locale?.toUpperCase()}</Row>
						<Row label="Mesaj">{open.message && <span style={{ whiteSpace: "pre-wrap" }}>{open.message}</span>}</Row>
					</div>

					<div className="space-y-4">
						<label className="text-sm font-medium" htmlFor="inquiry-status">
							Durum
						</label>
						<div id="inquiry-status">
							<StatusSelect
								value={statusOf(open.status).value}
								disabled={saving === open.id}
								onChange={(value) => void change(open.id, { status: value })}
							/>
						</div>
						<label className="text-sm font-medium" htmlFor="inquiry-notes">
							Operasyon notları (müşteri görmez)
						</label>
						<textarea
							id="inquiry-notes"
							rows={5}
							value={notes}
							style={{ ...control, width: "100%", display: "block" }}
							onChange={(event) => setNotes(event.target.value)}
						/>
						<div className="flex items-center gap-3 flex-wrap">
							<Button
								onClick={() => void change(open.id, { notes })}
								loading={saving === open.id}
								disabled={notes === (open.notes ?? "")}
							>
								Notu kaydet
							</Button>
							<a className="text-sm text-kumo-link underline" href={`/_emdash/admin/content/inquiries/${open.id}`}>
								Kaydı düzenleyicide aç
							</a>
						</div>
					</div>
				</aside>
			)}
		</div>
	);
}

const BOARD_URL = "/_emdash/admin/plugins/inquiries/talepler";

/** Kontrol Paneli card: how many requests wait at each step, and the newest few. */
function RequestsWidget() {
	const [items, setItems] = React.useState<Inquiry[] | null>(null);
	const [failed, setFailed] = React.useState(false);

	React.useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await apiFetch(`${API}/board`);
				const data = await parseApiResponse<{ items: Inquiry[] }>(response);
				if (!cancelled) setItems(data.items);
			} catch {
				if (!cancelled) setFailed(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (failed) return <p className="text-sm text-kumo-subtle">Talepler yüklenemedi.</p>;
	if (!items) {
		return (
			<div className="flex items-center gap-2">
				<Loader size="sm" />
				<span className="text-sm text-kumo-subtle">Talepler yükleniyor…</span>
			</div>
		);
	}

	const waiting = items.filter((item) => item.status === "new");
	return (
		<div className="space-y-4">
			<div className="flex gap-3 flex-wrap">
				{STATUSES.map((s) => (
					<a
						key={s.value}
						href={BOARD_URL}
						className="flex-1 border border-kumo-line rounded-lg px-4 py-3 bg-kumo-base"
						style={{ minWidth: 130, borderTop: `3px solid var(--color-kumo-badge-${s.color})` }}
					>
						<div className="text-2xl font-bold tabular-nums">{items.filter((item) => item.status === s.value).length}</div>
						<div className="text-xs text-kumo-subtle">{s.label}</div>
					</a>
				))}
			</div>

			{waiting.length > 0 ? (
				<div>
					<div className="text-xs uppercase tracking-wide text-kumo-subtle mb-4">Yanıt bekleyen yeni talepler</div>
					<div className="border border-kumo-line rounded-lg bg-kumo-base">
						{waiting.slice(0, 5).map((item) => {
							const d = detailsOf(item);
							return (
								<a key={item.id} href={BOARD_URL} className="flex items-center gap-4 px-4 py-3 border-b border-kumo-line text-sm flex-wrap">
									<span className="font-semibold tabular-nums" dir="ltr">
										{item.reference}
									</span>
									<span className="flex-1 min-w-0 truncate">
										{item.name}
										{item.kind === "transfer" ? ` · ${d.from} → ${d.to}` : ` · ${kindLabel(item.kind)}`}
									</span>
									<span className="text-kumo-subtle whitespace-nowrap">{travelDay(d) || when(item.submittedAt)}</span>
								</a>
							);
						})}
					</div>
				</div>
			) : (
				<p className="text-sm text-kumo-subtle">Yanıt bekleyen yeni talep yok.</p>
			)}

			<a href={BOARD_URL} className="text-sm text-kumo-link underline">
				Talep Yönetimi'ni aç
			</a>
		</div>
	);
}

export const widgets: PluginAdminExports["widgets"] = {
	talepler: RequestsWidget,
};

export const pages: PluginAdminExports["pages"] = {
	"/talepler": BoardPage,
};
