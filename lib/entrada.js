// Lo común a los dos webhooks de WhatsApp (Meta y YCloud): leer el cuerpo tal como llegó
// y atender un mensaje entrante sin repetirlo.
import { atenderWhatsApp } from "./conversacion.js";
import { enviarTexto } from "./whatsapp.js";
import { esNuevo, leerAjustes, anotar } from "./store.js";
import { hayClave } from "./agente.js";

/** El cuerpo sin tocar, para comprobar la firma. */
export async function cuerpoCrudo(req) {
  if (typeof req.rawBody === "string") return req.rawBody; // servidor local
  if (!req.readableEnded) {
    const trozos = [];
    for await (const trozo of req) trozos.push(trozo);
    if (trozos.length) return Buffer.concat(trozos).toString("utf8");
  }
  return JSON.stringify(req.body ?? {});
}

// Modo de prueba: con WHATSAPP_SOLO_NUMEROS el asistente solo le contesta a esos teléfonos
// (separados por coma) y deja pasar el resto, que la tienda sigue atendiendo a mano.
const digitos = (t) => String(t).replace(/\D/g, "");
function permitido(telefono) {
  const lista = (process.env.WHATSAPP_SOLO_NUMEROS ?? "").split(",").map(digitos).filter(Boolean);
  return !lista.length || lista.includes(digitos(telefono));
}

/**
 * @param {{id: string, telefono: string, tipo: string, texto?: string, bajar?: () => Promise<{mediaType: string, base64: string} | null>}} mensaje
 */
export async function atenderEntrante({ id, telefono, tipo, texto = "", bajar }) {
  try {
    const cola = String(telefono ?? "").slice(-4);
    if (!id || !telefono) return void (await anotar("mensaje sin datos", tipo));
    if (!permitido(telefono)) return void (await anotar("teléfono fuera de la lista de prueba", "termina en " + cola));
    // Apagado desde el panel: los mensajes siguen llegando al celular de la tienda y el asistente no contesta.
    if (!(await leerAjustes()).whatsappActivo) return void (await anotar("asistente apagado", "termina en " + cola));
    if (!(await esNuevo(id))) return void (await anotar("mensaje repetido", "termina en " + cola));
    await anotar("mensaje recibido", `${tipo}, termina en ${cola}`);
    if (!hayClave()) return void (await enviarTexto(telefono, "En este momento el asistente no está disponible. Escríbenos de nuevo en un rato."));
    if (tipo === "text") {
      const enviado = await enviarTexto(telefono, await atenderWhatsApp(telefono, texto));
      return void (await anotar(enviado ? "respondido" : "respuesta lista pero no se envió", "termina en " + cola));
    }
    if (tipo === "image") {
      const imagen = await bajar?.();
      if (!imagen) return void (await enviarTexto(telefono, "No pude abrir esa foto, veci. ¿Me la mandás otra vez?"));
      return void (await enviarTexto(telefono, await atenderWhatsApp(telefono, texto, imagen)));
    }
    await enviarTexto(telefono, "Por acá solo leo texto y fotos, veci. Escribime qué necesitás y te lo armo.");
  } catch (error) {
    console.error("whatsapp:", error);
    await anotar("error al atender", error?.message ?? error);
    await enviarTexto(telefono, "Se nos enredó algo por acá. Escribime de nuevo en un momento, porfa.").catch(() => {});
  }
}
