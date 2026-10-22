import { CATALOGO, METODOS_PAGO, totales, horario, cargarNegocio, revisarProgramado, momentoDe, cantidadValida } from "../lib/comun.js";
import { exigirSesion } from "../lib/usuarios.js";
import { listarPedidos, leerPedido, guardarPedido, borrarPedido, reponer } from "../lib/store.js";
import { avisoDeTienda } from "../lib/conversacion.js";
import { enviarTexto } from "../lib/whatsapp.js";
import { avisarEntrega } from "../lib/opiniones.js";
import { asignarYAvisar } from "../lib/domiciliarios.js";
import { soltarPromo } from "../lib/promo.js";

// Estados que puede poner la página del cliente y estados que solo mueve el panel.
// "alistando" solo lo puede poner el cliente cuando paga contraentrega: no hay pago que confirmar.
const DEL_CLIENTE = ["armando", "esperando_pago", "por_confirmar", "alistando"];
const DEL_PANEL = ["esperando_pago", "alistando", "en_camino", "entregado", "cancelado"];
// Por qué se cancela un pedido que ya estaba en la tienda.
const MOTIVOS = ["El cliente canceló", "No se encontró la dirección", "No había producto", "Otro", "Pedido de prueba"];
const texto = (v, max) => String(v ?? "").slice(0, max);

/** Reconstruye el pedido con nombres y precios del catálogo: lo que diga el navegador no cuenta. */
function pedidoLimpio(entrada, anterior) {
  const id = texto(entrada.id, 40);
  if (!/^p[a-z0-9]{6,39}$/.test(id)) return null;
  if (!DEL_CLIENTE.includes(entrada.status)) return null;
  const items = [];
  for (const it of Array.isArray(entrada.items) ? entrada.items.slice(0, 80) : []) {
    const producto = CATALOGO.get(String(it.sku));
    const qty = cantidadValida(producto, it.qty);
    if (!producto || !qty) return null;
    items.push({ sku: String(it.sku), name: producto.nombre, price: producto.precio, qty });
  }
  if (!items.length && entrada.status !== "armando") return null;
  // La hora programada la revisa el servidor: si no sirve, el pedido queda para entrega inmediata.
  const revisado = entrada.programado?.ts ? revisarProgramado(entrada.programado.ts) : null;
  const programado = revisado && !revisado.error ? revisado : null;
  // La tarifa del domicilio queda fija desde que el cliente cierra el pedido: mandar el comprobante en
  // otra franja horaria no la cambia. Solo cambia si pide otra hora de entrega.
  const calculado = totales(items, momentoDe({ programado }));
  const mismaHora = (anterior?.programado?.ts ?? 0) === (programado?.ts ?? 0);
  const domicilio = !items.length ? 0 : (mismaHora ? anterior?.domicilioFijo : undefined) ?? calculado.domicilio;
  const bolsa = !items.length ? 0 : anterior?.bolsaFija ?? calculado.bolsa;
  const total = calculado.subtotal + domicilio + bolsa;
  const pago = METODOS_PAGO.includes(entrada.pago) ? entrada.pago : "";
  const direccion = texto(entrada.direccion, 160);
  const pagaCon = Math.max(0, Math.floor(Number(entrada.pagaCon) || 0));
  const proof = typeof entrada.proof === "string" && entrada.proof.startsWith("data:image/jpeg;base64,") && entrada.proof.length <= 300_000 ? entrada.proof : "";
  if (entrada.status === "por_confirmar" && (pago !== "Transferencia" || !proof)) return null;
  if (entrada.status === "alistando" && (pago !== "Contraentrega" || !direccion || pagaCon < total)) return null;
  return {
    id,
    no: anterior?.no ?? Math.floor(Number(entrada.no)) % 100000,
    canal: "Web",
    direccion,
    pago,
    pagaCon: pago === "Contraentrega" ? pagaCon : 0,
    // Fuera del horario de domicilios queda como encargo; lo decide la hora del servidor, no la página.
    programado,
    domicilioFijo: entrada.status === "armando" ? (mismaHora ? anterior?.domicilioFijo : undefined) : domicilio,
    bolsaFija: entrada.status === "armando" ? anterior?.bolsaFija : bolsa,
    encargo: entrada.status === "armando" ? "" : programado ? `Programado: ${programado.fijo}` : anterior?.encargo || horario().encargo,
    status: entrada.status,
    items,
    total,
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
        return pedido ? res.status(200).json({ pedido: { ...pedido, proof: "", cliente: undefined } }) : res.status(404).json({ error: "No existe" });
      }
      if (!(await exigirSesion(req, res))) return;
      return res.status(200).json({ pedidos: await listarPedidos() });
    }

    if (req.method === "POST") {
      await cargarNegocio();
      const anterior = await leerPedido(texto(req.body?.id, 40));
      // Cuando la tienda ya lo tomó, el cliente no puede reescribirlo.
      if (anterior && !["armando", "esperando_pago"].includes(anterior.status)) return res.status(409).json({ error: "El pedido ya está en la tienda." });
      const pedido = pedidoLimpio(req.body ?? {}, anterior);
      if (!pedido) return res.status(400).json({ error: "Pedido no válido" });
      await guardarPedido(pedido);
      return res.status(200).json({ ok: true, total: pedido.total });
    }

    if (req.method === "PATCH") {
      if (!(await exigirSesion(req, res))) return;
      const pedido = await leerPedido(texto(req.body?.id, 40));
      if (pedido && req.body?.cambios?.efectivoEnCaja === true) {
        Object.assign(pedido, { efectivoPorEntregar: 0, efectivoEnCajaEn: Date.now() });
        await guardarPedido(pedido);
        return res.status(200).json({ ok: true });
      }
      const estado = req.body?.cambios?.status;
      if (!pedido || !DEL_PANEL.includes(estado)) return res.status(400).json({ error: "Cambio no válido" });
      // Cancelar solo aplica a pedidos que ya están en la tienda (alistando o en camino); uno ya entregado
      // solo se anula si fue de prueba.
      const dePrueba = estado === "cancelado" && req.body?.cambios?.motivo === "Pedido de prueba";
      if (estado === "cancelado" && !["alistando", "en_camino"].includes(pedido.status) && !(dePrueba && pedido.status === "entregado")) return res.status(400).json({ error: "Ese pedido no se puede cancelar desde aquí." });
      pedido.status = estado;
      if (estado === "esperando_pago") Object.assign(pedido, { rechazo: Date.now(), proof: "", proofMonto: 0 });
      // Al despachar se asigna el domiciliario y le llega el pedido por WhatsApp.
      if (estado === "en_camino") {
        if (!pedido.codigo) pedido.codigo = String(1000 + Math.floor(Math.random() * 9000));
        await asignarYAvisar(pedido, String(req.body?.cambios?.domiciliario ?? ""));
      }
      if (estado === "entregado") Object.assign(pedido, { entregadoEn: Date.now(), efectivoPorEntregar: pedido.pago === "Contraentrega" ? pedido.total : 0 });
      if (estado === "cancelado") {
        const motivo = MOTIVOS.includes(req.body?.cambios?.motivo) ? req.body.cambios.motivo : "Otro";
        // Las unidades vuelven una sola vez, y solo si salieron y la tienda no las marcó como perdidas.
        const devolver = req.body?.cambios?.devolver !== false && pedido.descontado && !pedido.devuelto;
        if (devolver) await reponer(pedido.items);
        Object.assign(pedido, { motivoCancelacion: motivo, canceladoEn: Date.now(), devuelto: Boolean(pedido.devuelto || devolver), efectivoPorEntregar: 0 });
        // Un pedido cancelado no gasta el descuento del cliente: lo recupera para el próximo (el total se conserva para el historial).
        if (pedido.descuento) await soltarPromo({ ...pedido });
      }
      await guardarPedido(pedido);
      // Cancelado: el tablero no tiene columna para ese estado y no cuenta como venta; se conserva para
      // que la página del cliente se entere y para el historial.
      // Si el pedido llegó por WhatsApp, el aviso le sale al cliente por ese mismo chat.
      // A un pedido de prueba no se le avisa nada al cliente.
      const aviso = dePrueba ? null : await avisoDeTienda(pedido);
      if (aviso && estado === "entregado") await avisarEntrega(pedido, aviso);
      else if (aviso) await enviarTexto(pedido.cliente, aviso);
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      if (!(await exigirSesion(req, res))) return;
      await borrarPedido(texto(req.query?.id, 40));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("orders:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
