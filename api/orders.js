import { CATALOGO, METODOS_PAGO, totales, horario, cargarNegocio, revisarProgramado, momentoDe, cantidadValida } from "../lib/comun.js";
import { exigirSesion } from "../lib/usuarios.js";
import { listarPedidos, leerPedido, guardarPedido, borrarPedido, reponer, anotar, listarArchivados, restaurarPedido, listarVentas, fotosDePedido } from "../lib/store.js";
import { avisoDeTienda, avisoDiferencia } from "../lib/conversacion.js";
import { cobroEnEfectivo } from "../lib/tienda.js";
import { enviarTexto } from "../lib/whatsapp.js";
import { avisarEntrega } from "../lib/opiniones.js";
import { asignarYAvisar } from "../lib/domiciliarios.js";
import { soltarPromo } from "../lib/promo.js";
import { revisarRecordatoriosDePaso } from "../lib/recordatorios.js";

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
      // Las fotos de un pedido (comprobante y entrega), solo para el panel: la lista no las trae.
      if (req.query?.id && req.query?.fotos) {
        if (!(await exigirSesion(req, res))) return;
        const fotos = await fotosDePedido(texto(req.query.id, 40));
        return fotos ? res.status(200).json(fotos) : res.status(404).json({ error: "No existe" });
      }
      if (req.query?.id) {
        const pedido = await leerPedido(texto(req.query.id, 40), false, false);
        return pedido ? res.status(200).json({ pedido: { ...pedido, proof: "", fotoEntrega: undefined, tieneComprobante: undefined, tieneFotoEntrega: undefined, cliente: undefined } }) : res.status(404).json({ error: "No existe" });
      }
      if (!(await exigirSesion(req, res))) return;
      if (req.query?.archivados) return res.status(200).json({ pedidos: await listarArchivados() });
      // Resumen de varios días: las ventas desde una fecha (máximo un año atrás), sin la foto del comprobante.
      if (req.query?.ventasDesde) {
        const desde = Math.max(Date.now() - 366 * 86400000, Math.floor(Number(req.query.ventasDesde)) || 0);
        return res.status(200).json({ pedidos: (await listarVentas(desde)).map(({ proof, fotoEntrega, ...p }) => p) });
      }
      // El panel consulta esto cada pocos segundos: de paso se revisan los recordatorios de pedidos sin cerrar.
      await revisarRecordatoriosDePaso();
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
      const yo = await exigirSesion(req, res);
      if (!yo) return;
      // Devolver al tablero un pedido archivado (vuelve a su columna y a las ventas).
      if (req.body?.restaurar === true) {
        const archivado = await leerPedido(texto(req.body?.id, 40));
        if (!archivado) return res.status(404).json({ error: "No existe" });
        await restaurarPedido(archivado.id);
        await anotar(`${yo.nombre || yo.usuario} restauró el pedido #${archivado.no}`, archivado.status).catch(() => {});
        return res.status(200).json({ ok: true });
      }
      const pedido = await leerPedido(texto(req.body?.id, 40));
      if (pedido && req.body?.cambios?.efectivoEnCaja === true) {
        Object.assign(pedido, { efectivoPorEntregar: 0, efectivoEnCajaEn: Date.now() });
        await guardarPedido(pedido);
        return res.status(200).json({ ok: true });
      }
      // Foto de la entrega puesta a mano (por ejemplo, la que el domiciliario mandó al chat cuando la tienda ya lo
      // había marcado entregado). Llega ya reducida desde el panel. No reemplaza una que ya tenga.
      if (pedido && typeof req.body?.cambios?.fotoEntrega === "string") {
        const foto = req.body.cambios.fotoEntrega;
        if (!foto.startsWith("data:image/jpeg;base64,") || foto.length < 1000 || foto.length > 300_000) return res.status(400).json({ error: "La foto no es válida." });
        if (pedido.status !== "entregado") return res.status(400).json({ error: "Solo a un pedido entregado." });
        if (pedido.fotoEntrega) return res.status(409).json({ error: "Ese pedido ya tiene foto de entrega." });
        Object.assign(pedido, { fotoEntrega: foto, fotoPesada: false, ...(pedido.entregadoPor ? {} : pedido.domiciliario?.nombre ? { entregadoPor: pedido.domiciliario.nombre } : {}) });
        await guardarPedido(pedido);
        await anotar(`${yo.nombre || yo.usuario} guardó la foto de entrega del pedido #${pedido.no}`, "desde el chat").catch(() => {});
        return res.status(200).json({ ok: true });
      }
      // Lo que el cliente agregó a un pedido ya pagado: la tienda confirma que llegó la transferencia de la diferencia.
      if (pedido && req.body?.cambios?.diferenciaConfirmada === true) {
        if (!pedido.diferencia || pedido.diferencia.pago !== "Transferencia") return res.status(400).json({ error: "Ese pedido no tiene una diferencia por transferencia." });
        Object.assign(pedido.diferencia, { estado: "confirmada", confirmadaPor: yo.nombre || yo.usuario, confirmadaEn: Date.now() });
        await guardarPedido(pedido);
        await anotar(`${yo.nombre || yo.usuario} confirmó la diferencia del pedido #${pedido.no}`, `$${pedido.diferencia.valor}`).catch(() => {});
        const aviso = await avisoDiferencia(pedido);
        if (aviso) await enviarTexto(pedido.cliente, aviso);
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
      if (estado === "entregado") Object.assign(pedido, { entregadoEn: Date.now(), efectivoPorEntregar: cobroEnEfectivo(pedido).valor });
      if (estado === "cancelado") {
        const motivo = MOTIVOS.includes(req.body?.cambios?.motivo) ? req.body.cambios.motivo : "Otro";
        // Las unidades vuelven una sola vez, y solo si salieron y la tienda no las marcó como perdidas.
        const devolver = req.body?.cambios?.devolver !== false && pedido.descontado && !pedido.devuelto;
        if (devolver) await reponer(pedido.items);
        // Queda en el Diagnóstico quién lo canceló y por qué (al cliente le llega el aviso).
        await anotar(`${yo.nombre || yo.usuario} canceló el pedido #${pedido.no}`, motivo).catch(() => {});
        Object.assign(pedido, { canceladoPor: yo.nombre || yo.usuario, motivoCancelacion: motivo, canceladoEn: Date.now(), devuelto: Boolean(pedido.devuelto || devolver), efectivoPorEntregar: 0 });
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
      const yo = await exigirSesion(req, res);
      if (!yo) return;
      // Solo se quita del tablero un pedido que no llegó a la tienda (sin pagar): uno entregado es una venta y
      // uno alistando o en camino se cancela con su motivo.
      const pedido = await leerPedido(texto(req.query?.id, 40));
      if (pedido && ["alistando", "en_camino", "entregado"].includes(pedido.status)) return res.status(400).json({ error: "Ese pedido no se puede quitar: es una venta o está en la tienda." });
      await borrarPedido(texto(req.query?.id, 40));
      if (pedido) await anotar(`${yo.nombre || yo.usuario} quitó del tablero el pedido #${pedido.no}`, pedido.status).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("orders:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
