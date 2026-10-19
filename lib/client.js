/**
 * Browser half of dsh-workbuddy-search.
 *
 * It carries no search UI — the tool is agent-facing. What lives here is the
 * self-update notice: on every DSH start the plugin asks the host whether a
 * newer release is published, and offers to install it.
 *
 * "Later" only hides the notice for this page; the next start checks again.
 */
window.__ModuleLoader__.load({
	id: "dsh-workbuddy-search",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		const name = "dsh-workbuddy-search";
		/** Locale namespace for the notice copy. */
		const NS = "workbuddy-search";

		const inject = ["slots", "locale"];

		/** Routes served by this plugin's host half. */
		const CHECK_PATH = "/plugins/dsh-workbuddy-search/update-check";
		const APPLY_PATH = "/plugins/dsh-workbuddy-search/update";

		const en = {
			title: "A newer version of this plugin is available",
			update: "Update",
			later: "Later",
			updating: "Updating…",
			current: "installed {version} · latest {latest}",
			done: "Updated to {version} — quit DSH completely and reopen it to apply.",
			failed: "Update failed: {message}",
			failedHint: "You can run it yourself: dsh plugin add {name}@{version}"
		};
		const zh = {
			title: "这个插件有新版本",
			update: "更新",
			later: "以后更新",
			updating: "正在更新…",
			current: "已安装 {version} · 最新 {latest}",
			done: "已更新到 {version}——请完全退出 DSH 后重新打开以生效。",
			failed: "更新失败：{message}",
			failedHint: "也可以手动执行：dsh plugin add {name}@{version}"
		};

		const cardStyle = {
			position: "fixed",
			right: "20px",
			bottom: "20px",
			width: "340px",
			maxWidth: "calc(100vw - 40px)",
			boxSizing: "border-box",
			padding: "14px 16px",
			borderRadius: "12px",
			border: "1px solid var(--dsw-alias-border-default, rgba(0,0,0,.12))",
			background: "var(--dsw-alias-bg-elevated, #fff)",
			boxShadow: "0 12px 32px rgba(0,0,0,.18)",
			fontSize: "13px",
			lineHeight: "20px",
			color: "var(--dsw-alias-label-primary, #111)",
			zIndex: 2147483000
		};
		const headerStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: "8px"
		};
		const titleStyle = { fontWeight: 600, paddingRight: "8px" };
		const linkButtonStyle = {
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary, #666)",
			cursor: "pointer",
			fontSize: "12px",
			padding: "2px 4px",
			whiteSpace: "nowrap"
		};
		const metaStyle = { fontSize: "11px", opacity: 0.65, marginTop: "4px" };
		const actionRowStyle = { display: "flex", justifyContent: "flex-end", marginTop: "10px" };
		const actionStyle = {
			border: "1px solid #111",
			background: "#111",
			color: "#fff",
			borderRadius: "7px",
			padding: "4px 14px",
			cursor: "pointer",
			fontSize: "12px"
		};
		const noteStyle = { fontSize: "11px", opacity: 0.75, marginTop: "8px", wordBreak: "break-word" };

		/** Ask the host whether a newer release exists. */
		async function checkForUpdate() {
			const response = await fetch(CHECK_PATH, {
				headers: { accept: "application/json" },
				credentials: "same-origin"
			});
			if (!response.ok) return undefined;
			const document = await response.json().catch(() => undefined);
			return document !== null && typeof document === "object" ? document : undefined;
		}

		/** Ask the host to install the published version. */
		async function applyUpdate(version) {
			const response = await fetch(APPLY_PATH, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				credentials: "same-origin",
				body: JSON.stringify({ version })
			});
			const document = await response.json().catch(() => undefined);
			if (response.ok && document?.ok === true) return { ok: true };
			return { ok: false, message: String(document?.message ?? document?.error ?? `HTTP ${response.status}`) };
		}

		/** The self-update notice. Dismissal is page state: a restart asks again. */
		function UpdateNotice(props) {
			const { t } = props;
			const [report, setReport] = react.useState(undefined);
			const [dismissed, setDismissed] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(undefined);

			react.useEffect(() => {
				let alive = true;
				checkForUpdate()
					.then((value) => {
						if (alive) setReport(value);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, []);

			if (dismissed) return null;
			if (report === undefined || report.status !== "update-available") return null;

			const run = async () => {
				setBusy(true);
				const outcome = await applyUpdate(report.latest).catch((error) => ({
					ok: false,
					message: String(error?.message ?? error)
				}));
				setBusy(false);
				setResult(
					outcome.ok
						? { kind: "done", text: t("done", { version: report.latest }) }
						: {
								kind: "failed",
								text: t("failed", { message: outcome.message }),
								hint: t("failedHint", { name: name, version: report.latest })
							}
				);
			};

			return jsxs("div", {
				style: cardStyle,
				role: "status",
				children: [
					jsxs("div", {
						style: headerStyle,
						children: [
							jsx("span", { style: titleStyle, children: t("title") }),
							jsx("button", {
								type: "button",
								style: linkButtonStyle,
								onClick: () => setDismissed(true),
								children: t("later")
							})
						]
					}),
					jsx("div", {
						style: metaStyle,
						children: `${name} · ${t("current", { version: report.current ?? "?", latest: report.latest ?? "?" })}`
					}),
					result === undefined
						? jsx("div", {
								style: actionRowStyle,
								children: jsx("button", {
									type: "button",
									style: busy ? { ...actionStyle, opacity: 0.6, cursor: "default" } : actionStyle,
									disabled: busy,
									onClick: run,
									children: busy ? t("updating") : t("update")
								})
							})
						: jsxs("div", {
								style: noteStyle,
								children: [jsx("div", { children: result.text }), result.hint === undefined ? null : jsx("div", { style: { opacity: 0.8 }, children: result.hint })]
							})
				]
			});
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "dsh-workbuddy-search: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "workbuddy-search-update",
						order: 70,
						locale: NS,
						inject: () => ({ t })
					},
					UpdateNotice
				)
			);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
