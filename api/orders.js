import { CATALOGO, COSTO_DOMICILIO, DOMICILIO_GRATIS_DESDE, exigirPin } from "../lib/comun.js";
import { listarPedidos, leerPedido, guardarPedido, borrarPedido } from "../lib/store.js";

// Estados que puede poner la página del cliente y estados que solo mueve el panel.
const DEL_CLIENTE = ["armando", "esperando_pago", "por_confirmar"];
const DEL_PANEL = ["esperando_pago", "alistando", "en_camino", "entregado"];
const texto = (v, max) => String(v ?? "").slice(0, max);

/** Reconstruye el pedido con nombres y precios del catálogo: lo que diga el navegador no cuenta. */
function pedidoLimpio(entrada, anterior) {
  const id = texto(entrada.id, 40);
  if (!/^p[a-z0-9]{6,39}$/.test(id)) return null;
  if (!DEL_CLIENTE.includes(entrada.status)) return null;
  const items = [];
  for (const it of Array.isArray(entrada.items) ? entrada.items.slice(0, 80) : []) {
    const producto = CATALOGO.get(String(it.sku));
    const qty = Math.floor(Number(it.qty));
    if (!producto || !(qty >= 1 && qty <= 99)) return null;
    items.push({ sku: String(it.sku), name: producto.nombre, price: producto.precio, qty });
  }
  if (!items.length && entrada.status !== "armando") return null;
  const subtotal = items.reduce((s, i) => s + i.qty * i.price, 0);
  const domicilio = subtotal === 0 || subtotal >= DOMICILIO_GRATIS_DESDE ? 0 : COSTO_DOMICILIO;
  const proof = typeof entrada.proof === "string" && entrada.proof.startsWith("data:image/jpeg;base64,") && entrada.proof.length <= 300_000 ? entrada.proof : "";
  if (entrada.status === "por_confirmar" && !proof) return null;
  return {
    id,
    no: anterior?.no ?? Math.floor(Number(entrada.no)) % 100000,
    canal: "Web",
    direccion: texto(entrada.direccion, 160),
    pago: ["Nequi", "Transferencia"].includes(entrada.pago) ? entrada.pago : "",
    status: entrada.status,
    items,
    total: subtotal + domicilio,
    proof,
    proofMonto: Math.max(0, Math.floor(Number(entrada.proofMonto) || 0)),
    rechazo: anterior?.rechazo ?? 0,
    hora: anterior?.hora ?? Date.now(),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      // Con id: el cliente consulta su propio pedido. Sin id: la lista completa, solo para el panel.
      if (req.query?.id) {
        const pedido = await leerPedido(texto(req.query.id, 40));
        return pedido ? res.status(200).json({ pedido: { ...pedido, proof: "" } }) : res.status(404).json({ error: "No existe" });
      }
      if (!exigirPin(req, res)) return;
      return res.status(200).json({ pedidos: await listarPedidos() });
    }

    if (req.method === "POST") {
      const anterior = await leerPedido(texto(req.body?.id, 40));
      // Cuando la tienda ya lo tomó, el cliente no puede reescribirlo.
      if (anterior && !["armando", "esperando_pago"].includes(anterior.status)) return res.status(409).json({ error: "El pedido ya está en la tienda." });
      const pedido = pedidoLimpio(req.body ?? {}, anterior);
      if (!pedido) return res.status(400).json({ error: "Pedido no válido" });
      await guardarPedido(pedido);
      return res.status(200).json({ ok: true, total: pedido.total });
    }

    if (req.method === "PATCH") {
      if (!exigirPin(req, res)) return;
      const pedido = await leerPedido(texto(req.body?.id, 40));
      const estado = req.body?.cambios?.status;
      if (!pedido || !DEL_PANEL.includes(estado)) return res.status(400).json({ error: "Cambio no válido" });
      pedido.status = estado;
      if (estado === "esperando_pago") Object.assign(pedido, { rechazo: Date.now(), proof: "", proofMonto: 0 });
      await guardarPedido(pedido);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      if (!exigirPin(req, res)) return;
      await borrarPedido(texto(req.query?.id, 40));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("orders:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
