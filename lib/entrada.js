// Lo común a los dos webhooks de WhatsApp (Meta y YCloud): leer el cuerpo tal como llegó
// y atender un mensaje entrante sin repetirlo.
import { atenderWhatsApp } from "./conversacion.js";
import { enviarTexto } from "./whatsapp.js";
import { esNuevo } from "./store.js";
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

/**
 * @param {{id: string, telefono: string, tipo: string, texto?: string, bajar?: () => Promise<{mediaType: string, base64: string} | null>}} mensaje
 */
export async function atenderEntrante({ id, telefono, tipo, texto = "", bajar }) {
  try {
    if (!id || !telefono || !(await esNuevo(id))) return;
    if (!hayClave()) return void (await enviarTexto(telefono, "En este momento el asistente no está disponible. Escríbenos de nuevo en un rato."));
    if (tipo === "text") return void (await enviarTexto(telefono, await atenderWhatsApp(telefono, texto)));
    if (tipo === "image") {
      const imagen = await bajar?.();
      if (!imagen) return void (await enviarTexto(telefono, "No pude abrir esa foto, veci. ¿Me la mandás otra vez?"));
      return void (await enviarTexto(telefono, await atenderWhatsApp(telefono, texto, imagen)));
    }
    await enviarTexto(telefono, "Por acá solo leo texto y fotos, veci. Escribime qué necesitás y te lo armo.");
  } catch (error) {
    console.error("whatsapp:", error);
    await enviarTexto(telefono, "Se nos enredó algo por acá. Escribime de nuevo en un momento, porfa.").catch(() => {});
  }
}
