import { verificar, abrirSesion, cerrarSesion, leerSesion, cambiarClave, hayUsuarios, publico, normalizar, CLAVE_MINIMA } from "../lib/usuarios.js";
import { sumarIntento, leerIntentos, borrarIntentos } from "../lib/store.js";

const MAX_INTENTOS = 8;

// Sesión del panel: entrar, ver quién soy, cambiar mi contraseña y salir.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const registro = await leerSesion(req);
      if (registro) return res.status(200).json({ usuario: publico(registro) });
      // Sin ningún usuario creado, el panel ofrece crear el primer administrador.
      return res.status(401).json({ error: "Inicia sesión para continuar.", sinUsuarios: !(await hayUsuarios()) });
    }

    if (req.method === "POST") {
      const usuario = normalizar(req.body?.usuario);
      const clave = String(req.body?.clave ?? "");
      if (!usuario || !clave) return res.status(400).json({ error: "Escribe tu usuario y tu contraseña." });
      // Tras varios intentos fallidos seguidos, ese usuario queda bloqueado 15 minutos.
      if ((await leerIntentos(usuario)) >= MAX_INTENTOS) return res.status(429).json({ error: "Demasiados intentos. Espera 15 minutos y vuelve a intentar." });
      const registro = await verificar(usuario, clave);
      if (!registro) {
        await sumarIntento(usuario);
        return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
      }
      await borrarIntentos(usuario);
      await abrirSesion(res, registro);
      return res.status(200).json({ usuario: publico(registro) });
    }

    if (req.method === "PATCH") {
      const registro = await leerSesion(req);
      if (!registro) return res.status(401).json({ error: "Inicia sesión para continuar." });
      const nueva = String(req.body?.nueva ?? "");
      if (!(await verificar(registro.usuario, String(req.body?.actual ?? "")))) return res.status(400).json({ error: "La contraseña actual no es correcta." });
      if (nueva.length < CLAVE_MINIMA) return res.status(400).json({ error: `La contraseña nueva debe tener al menos ${CLAVE_MINIMA} caracteres.` });
      const { registro: actualizado } = await cambiarClave(registro.usuario, nueva);
      await abrirSesion(res, actualizado); // las demás sesiones de este usuario quedan cerradas
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      cerrarSesion(res);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    console.error("sesion:", error);
    return res.status(500).json({ error: "No se pudo completar. Intenta de nuevo." });
  }
}
