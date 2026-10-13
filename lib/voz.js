// Notas de voz: Claude no recibe audio, así que antes se transcriben con Whisper en Groq
// y al asistente le llega el texto. Sin GROQ_API_KEY el asistente pide que le escriban.
const URL_GROQ = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELO = process.env.GROQ_MODELO_VOZ || "whisper-large-v3-turbo";
const EXTENSIONES = { "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/aac": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/webm": "webm", "audio/amr": "amr", "video/mp4": "mp4" };

export const hayVoz = () => Boolean(process.env.GROQ_API_KEY);

/**
 * @param {{mediaType: string, bytes: Buffer}} audio
 * @returns {Promise<string>} lo que dijo el cliente; vacío si no se entendió nada
 */
export async function transcribir(audio) {
  const formulario = new FormData();
  formulario.append("file", new Blob([audio.bytes], { type: audio.mediaType }), `nota.${EXTENSIONES[audio.mediaType] ?? "ogg"}`);
  formulario.append("model", MODELO);
  formulario.append("language", "es");
  formulario.append("response_format", "json");
  // Las marcas y palabras de la tienda ayudan a que no las cambie por otras parecidas.
  formulario.append("prompt", "Pedido a domicilio a un minimarket en Cali: Coca Cola, Postobón, Águila, Poker, Detodito, Chocorramo, Bimbo, Alpina, Colanta, torre, apartamento, contraentrega, transferencia.");
  const respuesta = await fetch(URL_GROQ, { method: "POST", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: formulario });
  if (!respuesta.ok) throw new Error(`Transcripción falló: ${respuesta.status} ${(await respuesta.text()).slice(0, 200)}`);
  return String((await respuesta.json()).text ?? "").trim();
}
