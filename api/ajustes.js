import { exigirSesion } from "../lib/usuarios.js";
import { cargarNegocio, negocioLimpio } from "../lib/comun.js";
import { leerAjustes, guardarAjustes, leerBitacora, contarPromos, leerConsumo, marcarAsistenteCaido } from "../lib/store.js";
import { hayWhatsApp } from "../lib/whatsapp.js";
import { modeloEnUso } from "../lib/agente.js";

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
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const yo = await exigirSesion(req, res, req.query?.bitacora ? ["admin"] : undefined);
      if (!yo) return;
      const [ajustes, consumo] = await Promise.all([leerAjustes(), leerConsumo()]);
      const base = { whatsappActivo: ajustes.whatsappActivo, whatsappConectado: hayWhatsApp(), asistenteCaido: consumo.caido, apagadoSolo: Boolean(ajustes.apagadoSolo) };
      if (yo.rol !== "admin") return res.status(200).json(base);
      const negocio = await cargarNegocio(true);
      const ia = resumenDeIA(ajustes.credito, consumo);
      if (!req.query?.bitacora) return res.status(200).json({ ...base, negocio, ia, promos: await contarPromos() });
      // Para diagnosticar: los últimos pasos del canal de WhatsApp.
      return res.status(200).json({ ...base, negocio, ia, listaDePrueba: negocio.listaDePrueba, bitacora: await leerBitacora() });
    }
    if (req.method === "POST") {
      if (!(await exigirSesion(req, res, ["admin"]))) return;
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
      await guardarAjustes(ajustes);
      return res.status(200).json({ whatsappActivo: ajustes.whatsappActivo, whatsappConectado: hayWhatsApp(), asistenteCaido: consumo.caido, apagadoSolo: Boolean(ajustes.apagadoSolo), negocio: await cargarNegocio(true), ia: resumenDeIA(ajustes.credito, consumo) });
    }
    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("ajustes:", error);
    return res.status(500).json({ error: "No se pudo guardar. Intenta de nuevo." });
  }
}
