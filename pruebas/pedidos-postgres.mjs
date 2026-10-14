// Prueba el guardado de pedidos en Postgres con una base en memoria (pg-mem), sin tocar una real.
// Uso: npm install --no-save pg-mem && node pruebas/pedidos-postgres.mjs
import assert from "node:assert/strict";
import { newDb } from "pg-mem";

process.env.DATABASE_URL = "postgres://prueba@localhost/prueba";
globalThis.__saukoPgModulo = newDb().adapters.createPg();
const { guardarPedido, leerPedido, listarPedidos, borrarPedido, hayPostgres } = await import("../lib/store.js");

assert.equal(hayPostgres, true);
const pedido = { id: "pprueba0001", no: 1234, canal: "WhatsApp", cliente: "+573001112233", status: "armando", total: 10200, hora: Date.now(), direccion: "Torre 1", pago: "Contraentrega", pagaCon: 20000, items: [{ sku: "1", name: "Coca Cola 1.5", price: 8200, qty: 1 }] };

await guardarPedido(pedido);
assert.deepEqual(await leerPedido(pedido.id), pedido, "se lee igual a como se guardó");

await guardarPedido({ ...pedido, status: "alistando" });
assert.equal((await leerPedido(pedido.id)).status, "alistando", "guardar de nuevo actualiza");
assert.equal((await listarPedidos()).length, 1, "aparece en el panel una sola vez");

await guardarPedido({ ...pedido, id: "pprueba0002", no: 1235, hora: Date.now() - 5 * 86400000 });
assert.equal((await listarPedidos()).length, 1, "los de hace más de tres días no salen en el panel");

await borrarPedido(pedido.id);
assert.equal((await listarPedidos()).length, 0, "archivado sale del panel");
assert.equal((await leerPedido(pedido.id)).id, pedido.id, "pero queda en el historial");
assert.equal(await leerPedido("noexiste"), null);

// Cancelado en el panel y luego el cliente sigue: en WhatsApp arranca pedido nuevo; si se vuelve a guardar el mismo, reaparece.
assert.equal(await leerPedido(pedido.id, true), null, "un pedido archivado no se retoma");
await guardarPedido({ ...pedido, status: "alistando" });
assert.equal((await listarPedidos()).filter((p) => p.id === pedido.id).length, 1, "si el cliente lo vuelve a guardar, reaparece en el panel");

console.log("Pedidos en Postgres: todo bien.");
