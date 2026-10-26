// Avisos de Meta sobre la cuenta: quedan en el Diagnóstico y los graves salen en el panel.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
const { createHmac } = await import("node:crypto");
Object.assign(process.env, { WHATSAPP_TOKEN: "simulado", WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_APP_SECRET: "secreto", VERCEL: "1" });
globalThis.fetch = async () => { throw new Error("sin conexiones reales"); };
const store = await import("../lib/store.js");
const webhook = (await import("../api/whatsapp.js")).default;
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const avisar = (field, value) => new Promise((r) => { const crudo = JSON.stringify({ entry: [{ changes: [{ field, value }] }] }); webhook({ method: "POST", rawBody: crudo, headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", "secreto").update(crudo).digest("hex") }, query: {} }, { status(c) { this.c = c; return this; }, send() { r(this.c); } }); });
await avisar("phone_number_quality_update", { display_phone_number: "573136295251", event: "UNFLAGGED", current_limit: "TIER_1K" });
ok("buena noticia: al Diagnóstico pero no es alarma", !((await store.leerAjustes()).alertasMeta ?? []).length && (await store.leerBitacora()).some((b) => /calidad del número/.test(JSON.stringify(b))));
await avisar("phone_number_quality_update", { display_phone_number: "573136295251", event: "FLAGGED", current_limit: "TIER_250" });
await avisar("account_update", { event: "ACCOUNT_VIOLATION", violation_info: { violation_type: "SCAM" } });
const alertas = (await store.leerAjustes()).alertasMeta ?? [];
ok("calidad marcada e infracción: quedan como alertas para el panel (" + alertas.length + ")", alertas.length === 2 && /SCAM/.test(alertas[0].resumen) && alertas[1].tema === "calidad del número");

// Meta rechaza los envíos (sin método de pago, token vencido…): el panel lo dice en rojo hasta que vuelvan a salir.
const { envioCaido } = await import("../lib/conversaciones.js");
const estado = (id, destino, status, errors) => avisar("messages", { statuses: [{ id, recipient_id: destino, status, ...(errors ? { errors } : {}) }] });
await estado("w1", "573001112222", "failed", [{ code: 131026, title: "Message undeliverable" }]);
ok("un cliente que no recibe (131026) no es alarma", envioCaido(await store.leerEnvio()) === null);
await estado("w2", "573001113333", "failed", [{ code: 131042, title: "Business eligibility payment issue" }]);
const caido = envioCaido(await store.leerEnvio());
ok("131042 (pago): aviso rojo con la explicación de la tarjeta", caido && /pago/.test(caido.explicacion) && caido.clientes === 2 && caido.mensajes === 2);
await estado("w3", "573001114444", "delivered");
ok("cuando vuelve a entregar, el aviso se quita", envioCaido(await store.leerEnvio()) === null);
for (const [i, d] of ["573001110001", "573001110002", "573001110003"].entries()) await estado("x" + i, d, "failed", [{ code: 131000, title: "Something went wrong" }]);
ok("error desconocido seguido a varios clientes: también avisa", /131000/.test(envioCaido(await store.leerEnvio())?.motivo ?? ""));
