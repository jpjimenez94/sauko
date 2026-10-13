import { exigirSesion, hayUsuarios, listar, crear, cambiarClave, cambiarRol, eliminar, abrirSesion, publico, normalizar } from "../lib/usuarios.js";
import { pinDeInstalacionValido } from "../lib/comun.js";
import { leerUsuarios } from "../lib/store.js";

// Usuarios del panel. Solo los administradores los manejan.
// La única excepción es crear el primer administrador, que pide el PIN de instalación (PANEL_PIN).
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST" && !(await hayUsuarios())) {
      if (!pinDeInstalacionValido(req)) return res.status(401).json({ error: "El PIN de instalación no es correcto." });
      const { usuario } = await crear({ usuario: req.body?.usuario, nombre: req.body?.nombre, rol: "admin", clave: String(req.body?.clave ?? "") });
      await abrirSesion(res, (await leerUsuarios())[usuario.usuario]);
      return res.status(200).json({ usuario });
    }

    const yo = await exigirSesion(req, res, ["admin"]);
    if (!yo) return;

    if (req.method === "GET") return res.status(200).json({ usuarios: await listar() });

    if (req.method === "POST") {
      // La contraseña la genera el servidor y se devuelve una sola vez, para entregársela a la persona.
      const { usuario, clave } = await crear({ usuario: req.body?.usuario, nombre: req.body?.nombre, rol: req.body?.rol });
      return res.status(200).json({ usuario, clave });
    }

    if (req.method === "PATCH") {
      const quien = normalizar(req.body?.usuario);
      if (req.body?.accion === "clave") {
        const { registro, clave } = await cambiarClave(quien);
        // Si el administrador regenera la suya, su sesión sigue abierta con la versión nueva.
        if (registro.usuario === yo.usuario) await abrirSesion(res, registro);
        return res.status(200).json({ usuario: publico(registro), clave });
      }
      if (req.body?.accion === "rol") return res.status(200).json({ usuario: await cambiarRol(quien, req.body?.rol, yo.usuario) });
      return res.status(400).json({ error: "Acción no válida." });
    }

    if (req.method === "DELETE") {
      await eliminar(normalizar(req.query?.usuario), yo.usuario);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Método no permitido" });
  } catch (error) {
    // Los errores de validación (usuario repetido, último administrador...) se le muestran tal cual a quien administra.
    if (error instanceof Error && !/Redis|fetch|ECONN/i.test(error.message)) return res.status(400).json({ error: error.message });
    console.error("usuarios:", error);
    return res.status(500).json({ error: "No se pudo completar. Intenta de nuevo." });
  }
}
