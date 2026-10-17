import { pathToFileURL } from "node:url";
// Las pruebas nunca tocan bases ni servicios reales: se borran las variables antes de importar el proyecto.
for (const k of Object.keys(process.env)) if (/^(KV_|UPSTASH_|DATABASE_URL|POSTGRES|PG[A-Z]|YCLOUD_|ANTHROPIC|GROQ|WHATSAPP_)/.test(k)) delete process.env[k];
const raiz = pathToFileURL(process.cwd() + "/").href;
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "DATABASE_URL", "POSTGRES_URL", "YCLOUD_API_KEY", "YCLOUD_FROM"]) delete process.env[k];
Object.assign(process.env, { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "111" });
let perfil = { about: "Hola", vertical: "OTHER", websites: [] }, guardado = null, subida = null;
globalThis.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.includes("/111/whatsapp_business_profile") && (!o.method || o.method === "GET")) return new Response(JSON.stringify({ data: [perfil] }), { status: 200 });
  if (u.endsWith("/111/whatsapp_business_profile")) { guardado = JSON.parse(o.body); perfil = { ...perfil, ...guardado, ...(guardado.profile_picture_handle ? { profile_picture_url: "https://pps.whatsapp.net/foto.jpg" } : {}) }; return new Response('{"success":true}', { status: 200 }); }
  if (u.endsWith("/app")) return new Response('{"id":"2150049782538928"}', { status: 200 });
  if (u.includes("/2150049782538928/uploads")) return new Response('{"id":"upload:XYZ"}', { status: 200 });
  if (u.endsWith("/upload:XYZ")) { subida = o; return new Response('{"h":"HANDLE123"}', { status: 200 }); }
  return new Response("{}", { status: 200 });
};
const store = await import(raiz + "lib/store.js");
const usuarios = await import(raiz + "lib/usuarios.js");
const webhook = (await import(raiz + "api/whatsapp.js")).default;
const ok = (t, c) => console.log((c ? "OK    " : "FALLA ") + t);
const galletas = {};
for (const [u, rol] of [["admin1", "admin"], ["oper1", "operativo"]]) {
  await usuarios.crear({ usuario: u, nombre: u, rol, clave: "clave-de-prueba-1" });
  await usuarios.abrirSesion({ setHeader: (k, v) => { galletas[u] = String(v).split(";")[0]; } }, (await store.leerUsuarios())[u]);
}
const llamar = (quien, method, accion, body = {}) => new Promise((r) => webhook({ method, query: { accion }, headers: { cookie: galletas[quien] }, body }, { status(c) { this.c = c; return this; }, json(d) { r([this.c, d]); }, send(d) { r([this.c, d]); }, setHeader() {} }));
let [c, d] = await llamar("admin1", "GET", "perfil");
ok("admin lee el perfil", c === 200 && d.perfil.about === "Hola");
[c] = await llamar("oper1", "GET", "perfil");
ok("operativo no puede", c === 403);
[c, d] = await llamar("admin1", "POST", "perfil", { about: "Domicilios en Kachipay", description: "Minimercado", address: "Cl 60A", email: "saukostore1@gmail.com", websites: ["https://www.saukostoreminimarket.com", "no-es-url", "https://www.instagram.com/sauko.store"], vertical: "GROCERY" });
ok("guarda campos con messaging_product, sitios válidos (2) y categoría", c === 200 && guardado.messaging_product === "whatsapp" && guardado.websites.length === 2 && guardado.vertical === "GROCERY" && d.perfil.about === "Domicilios en Kachipay");
[c, d] = await llamar("admin1", "POST", "perfil", { email: "malo" });
ok("correo inválido: 400", c === 400);
[c, d] = await llamar("admin1", "POST", "perfil-foto", { tipo: "image/jpeg", base64: Buffer.alloc(5000, 1).toString("base64") });
ok("foto: subida por partes y se guarda el handle", c === 200 && subida?.headers?.file_offset === "0" && guardado.profile_picture_handle === "HANDLE123" && d.perfil.profile_picture_url);
