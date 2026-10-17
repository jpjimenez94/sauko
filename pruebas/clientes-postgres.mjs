// Prueba Clientes y el historial largo de los chats en Postgres con una base en memoria (pg-mem).
// Uso: npm install --no-save pg-mem && node pruebas/clientes-postgres.mjs
import assert from "node:assert/strict";
import { newDb } from "pg-mem";

for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
process.env.DATABASE_URL = "postgres://prueba@localhost/prueba";
const db = newDb();
// pg-mem no trae to_timestamp: se le enseña (segundos desde 1970 -> fecha).
db.public.registerFunction({ name: "to_timestamp", args: ["float"], returns: "timestamptz", implementation: (s) => new Date(s * 1000) });
db.public.registerFunction({ name: "to_timestamp", args: ["numeric"], returns: "timestamptz", implementation: (s) => new Date(Number(s) * 1000) });
globalThis.__saukoPgModulo = db.adapters.createPg();
const { registrarMensaje, listarClientes, guardarPedido, guardarPromos, recordarDireccion, leerConversacion, hayPostgres } = await import("../lib/store.js");

assert.equal(hayPostgres, true);
const ANA = "573009998877", BETO = "CO.13491208655302741918";
const hace = (dias) => Date.now() - dias * 86400000;

await registrarMensaje(ANA, { id: "w1", dir: "in", de: "cliente", tipo: "text", texto: "hola", nombre: "Ana Pérez", hora: hace(40) });
await registrarMensaje(ANA, { id: "w2", dir: "out", de: "asistente", tipo: "text", texto: "Hola, veci", hora: hace(40) + 1000 });
await registrarMensaje(ANA, { id: "w3", dir: "in", de: "cliente", tipo: "text", texto: "quiero leche", hora: hace(1) });
await registrarMensaje(BETO, { id: "w4", dir: "in", de: "cliente", tipo: "text", texto: "buenas", usuario: "beto", hora: hace(2) });
await registrarMensaje(ANA, { id: "w1", dir: "in", de: "cliente", tipo: "text", texto: "hola", hora: hace(40) }); // reintento de Meta

await guardarPedido({ id: "pc1", no: 1, canal: "WhatsApp", cliente: ANA, status: "entregado", total: 15000, hora: hace(1), items: [] });
await guardarPedido({ id: "pc2", no: 2, canal: "WhatsApp", cliente: ANA, status: "cancelado", total: 9000, hora: hace(1), items: [] });
await guardarPedido({ id: "pc3", no: 3, canal: "WhatsApp", cliente: ANA, status: "alistando", total: 5000, hora: hace(0), items: [] });
await guardarPromos(ANA, true);
await recordarDireccion(ANA, "Torre 3 apto 502");

const clientes = await listarClientes();
assert.equal(clientes.length, 2, "dos clientes, sin repetir");
const ana = clientes.find((c) => c.id === ANA), beto = clientes.find((c) => c.id === BETO);
assert.equal(ana.nombre, "Ana Pérez", "conserva el nombre aunque los mensajes siguientes no lo traigan");
assert.equal(ana.direccion, "Torre 3 apto 502", "dirección recordada");
assert.equal(ana.pedidos, 2, "cuenta pedidos sin los cancelados");
assert.equal(ana.total, 20000, "suma lo comprado sin los cancelados");
assert.equal(ana.promos, true, "aceptó promociones");
assert.ok(ana.primer < ana.ultimo && ana.primer < hace(39), "primer y último contacto");
assert.equal(beto.usuario, "beto", "quien usa nombre de usuario queda con su @");
assert.equal(beto.pedidos, 0);
assert.equal(clientes[0].id, ANA, "ordenados por el último mensaje");

// Chat que ya no está en Redis: sale del historial de Postgres (aquí no hay Redis: la memoria tiene los mensajes,
// así que se prueba el historial leyendo un contacto que solo está en Postgres).
const { leerConversacion: leer } = await import("../lib/store.js");
globalThis.__sauko.convs.delete(ANA);
const chat = await leer(ANA);
assert.deepEqual(chat.mensajes.map((m) => m.id), ["w1", "w2", "w3"], "el historial trae los mensajes en orden y sin el repetido");
assert.equal(chat.ficha.nombre, "Ana Pérez");

console.log("Clientes e historial en Postgres: todo bien.");
