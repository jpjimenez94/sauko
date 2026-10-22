import { exigirSesion } from "../lib/usuarios.js";
import { cargarNegocio, negocioLimpio } from "../lib/comun.js";
import { leerAjustes, guardarAjustes, leerBitacora, contarPromos, leerConsumo, marcarAsistenteCaido, reiniciarDatos, anotar } from "../lib/store.js";
import { hayWhatsApp } from "../lib/whatsapp.js";
import { modeloEnUso } from "../lib/agente.js";
import { telefonoDomiciliario } from "../lib/domiciliarios.js";
import { turnoDe } from "../lib/store.js";
import { promoLimpia, promoDeHoy, PROMO_INICIAL } from "../lib/promo.js";

/** Lo que el panel muestra del gasto en IA. El saldo es una estimación: lo que el administrador dijo que había menos lo gastado desde entonces. */
function resumenDeIA(credito, consumo) {
  const saldo = credito ? Math.max(0, credito.saldo - (consumo.total - credito.marca)) : null;
  const porMensaje = consumo.mensajesMes > 0 ? consumo.mes / consumo.mensajesMes : null;
  return {
    modelo: modeloEnUso(),
    // El que contestó de verdad la última vez, según la respuesta de Anthropic, y cuándo.
    modeloReal: consumo.modelo,
    respondio: consumo.respondio,
    saldo,
    minimo: credito?.minimo ?? 0,
    saldoBajo: saldo !== null && saldo <= (credito?.minimo ?? 0),
    cuadradoEl: credito?.fecha ?? null,
    hoy: consumo.hoy,
    mes: consumo.mes,
    mensajesHoy: consumo.mensajesHoy,
    mensajesMes: consumo.mensajesMes,
    porMensaje,
    alcanzaPara: saldo !== null && porMensaje ? Math.floor(saldo / porMensaje) : null,
  };
}

// Ajustes del panel: el interruptor del asistente de WhatsApp, los parámetros del negocio
// (horario y valor del domicilio, cuenta para transferir, lista de prueba, pausa) y el gasto en IA.
// Cualquier usuario del panel ve el interruptor y si el asistente está caído; solo un administrador
// ve y cambia lo demás.
/** Los domiciliarios con su turno. El teléfono solo lo ve el administrador. */
async function domiciliariosPara(lista, admin) {
  return Promise.all((Array.isArray(lista) ? lista : []).map(async (d) => ({ id: d.id, nombre: d.nombre, activo: d.activo, turno: d.activo ? Boolean(await turnoDe(d.id)) : false, ...(admin ? { telefono: d.telefono } : {}) })));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const yo = await exigirSesion(req, res, req.query?.bitacora ? ["admin"] : undefined);
      if (!yo) return;
      const [ajustes, consumo] = await Promise.all([leerAjustes(), leerConsumo()]);
      const base = { whatsappActivo: ajustes.whatsappActivo, whatsappConectado: hayWhatsApp(), asistenteCaido: consumo.caido, apagadoSolo: Boolean(ajustes.apagadoSolo), alertasMeta: ajustes.alertasMeta ?? [], domiciliarios: await domiciliariosPara(ajustes.domiciliarios, yo.rol === "admin") };
      if (yo.rol !== "admin") return res.status(200).json(base);
      const negocio = await cargarNegocio(true);
      const ia = resumenDeIA(ajustes.credito, consumo);
      if (!req.query?.bitacora) return res.status(200).json({ ...base, negocio, ia, promos: await contarPromos(), promo: await promoDeHoy() });
      // Para diagnosticar: los últimos pasos del canal de WhatsApp.
      return res.status(200).json({ ...base, negocio, ia, listaDePrueba: negocio.listaDePrueba, bitacora: await leerBitacora() });
    }
    if (req.method === "POST") {
      if (!(await exigirSesion(req, res, ["admin"]))) return;
      // Dejar en cero los datos de prueba (pedidos, opiniones, solicitados, unidades).
      if (req.body?.reiniciar && typeof req.body.reiniciar === "object") {
        const r = req.body.reiniciar;
        const hecho = await reiniciarDatos({ pedidos: r.pedidos === true, opiniones: r.opiniones === true, solicitados: r.solicitados === true, inventario: r.inventario === true });
        await anotar("datos de prueba reiniciados", JSON.stringify(hecho));
        return res.status(200).json({ reiniciado: hecho });
      }
      const [ajustes, consumo] = await Promise.all([leerAjustes(), leerConsumo()]);
      if (typeof req.body?.whatsappActivo === "boolean") {
        ajustes.whatsappActivo = req.body.whatsappActivo;
        delete ajustes.apagadoSolo;
        // Al encenderlo a mano se da por resuelta la caída; si sigue sin saldo, se apagará de nuevo con el primer mensaje.
        if (ajustes.whatsappActivo && consumo.caido) {
          await marcarAsistenteCaido(null);
          consumo.caido = null;
        }
      }
      // Lo que no venga en el formulario conserva el valor vigente.
      if (req.body?.negocio && typeof req.body.negocio === "object") ajustes.negocio = negocioLimpio(req.body.negocio, await cargarNegocio(true));
      // El administrador cuadra el saldo con el que ve en la consola de Anthropic; desde ahí se descuenta lo gastado.
      if (req.body?.credito && typeof req.body.credito === "object") {
        const saldo = Number(req.body.credito.saldo);
        const minimo = Number(req.body.credito.minimo);
        if (!(saldo >= 0 && saldo <= 100000) || !(minimo >= 0 && minimo <= 100000)) return res.status(400).json({ error: "Escribe el saldo y el mínimo en dólares." });
        ajustes.credito = { saldo, minimo, marca: consumo.total, fecha: new Date().toISOString() };
      }
      // Promoción de la línea del asistente: interruptor, porcentajes y cupos (lib/promo.js).
      if (req.body?.promo && typeof req.body.promo === "object") ajustes.promo = promoLimpia(req.body.promo, ajustes.promo ?? PROMO_INICIAL);
      // Domiciliarios: la lista completa que manda el panel (nombre, WhatsApp y si está activo).
      if (Array.isArray(req.body?.domiciliarios)) {
        ajustes.domiciliarios = req.body.domiciliarios.slice(0, 20).map((d) => ({
          id: String(d.id || Math.random().toString(36).slice(2, 10)).slice(0, 20),
          nombre: String(d.nombre ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          telefono: telefonoDomiciliario(d.telefono),
          activo: d.activo !== false,
        })).filter((d) => d.nombre && (d.telefono.startsWith("@") ? d.telefono.length > 2 : d.telefono.length >= 10));
      }
      await guardarAjustes(ajustes);
      return res.status(200).json({ domiciliarios: await domiciliariosPara(ajustes.domiciliarios, true), whatsappActivo: ajustes.whatsappActivo, whatsappConectado: hayWhatsApp(), asistenteCaido: consumo.caido, apagadoSolo: Boolean(ajustes.apagadoSolo), negocio: await cargarNegocio(true), ia: resumenDeIA(ajustes.credito, consumo), promo: await promoDeHoy() });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("ajustes:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
