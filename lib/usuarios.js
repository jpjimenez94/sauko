// Usuarios del panel, contraseñas y sesiones.
// - Las contraseñas no se guardan: se guarda su huella (scrypt con sal propia por usuario).
// - La sesión es una cookie firmada que el navegador no deja leer a los scripts de la página.
// - Dos roles: "admin" maneja todo, incluidos los usuarios; "operativo" gestiona los pedidos.
import { scryptSync, randomBytes, randomInt, timingSafeEqual, createHmac } from "node:crypto";
import { leerUsuarios, guardarUsuarios, secretoDeSesiones } from "./store.js";

export const ROLES = ["admin", "operativo"];
const COOKIE = "sauko_sesion";
const DURACION_SEGUNDOS = 12 * 3600;
// Sin letras ni números que se confundan al dictarlos (0/O, 1/l/I).
const ALFABETO = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CLAVE_MINIMA = 8;

export const normalizar = (usuario) => String(usuario ?? "").trim().toLowerCase();
export const usuarioValido = (usuario) => /^[a-z0-9._-]{3,30}$/.test(usuario);

export function generarClave(largo = 12) {
  let clave = "";
  for (let i = 0; i < largo; i++) clave += ALFABETO[randomInt(ALFABETO.length)];
  return clave;
}

const huella = (clave, sal) => scryptSync(String(clave), sal, 64).toString("hex");
function mismaHuella(a, b) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Lo que se puede mostrar de un usuario: nunca la huella ni la sal. */
export const publico = (r) => ({ usuario: r.usuario, nombre: r.nombre, rol: r.rol, creado: r.creado });

export async function hayUsuarios() {
  return Object.keys(await leerUsuarios()).length > 0;
}

export async function listar() {
  return Object.values(await leerUsuarios()).map(publico).sort((a, b) => a.usuario.localeCompare(b.usuario));
}

/** Crea un usuario. Si no se pasa contraseña se genera una. Devuelve la contraseña para mostrarla una sola vez. */
export async function crear({ usuario, nombre, rol, clave }) {
  const id = normalizar(usuario);
  if (!usuarioValido(id)) throw new Error("El usuario debe tener de 3 a 30 letras, números, puntos o guiones, sin espacios.");
  if (!ROLES.includes(rol)) throw new Error("Rol no válido.");
  const usuarios = await leerUsuarios();
  if (usuarios[id]) throw new Error("Ya existe un usuario con ese nombre.");
  const secreta = clave ?? generarClave();
  if (String(secreta).length < CLAVE_MINIMA) throw new Error(`La contraseña debe tener al menos ${CLAVE_MINIMA} caracteres.`);
  const sal = randomBytes(16).toString("hex");
  usuarios[id] = { usuario: id, nombre: String(nombre ?? "").trim().slice(0, 60) || id, rol, sal, huella: huella(secreta, sal), version: 1, creado: Date.now() };
  await guardarUsuarios(usuarios);
  return { usuario: publico(usuarios[id]), clave: secreta };
}

/** Devuelve el usuario si la contraseña es la suya; null en cualquier otro caso. */
export async function verificar(usuario, clave) {
  const registro = (await leerUsuarios())[normalizar(usuario)];
  // Se calcula una huella aunque el usuario no exista, para que la respuesta tarde lo mismo.
  const calculada = huella(clave, registro?.sal ?? "00000000000000000000000000000000");
  return registro && mismaHuella(calculada, registro.huella) ? registro : null;
}

/** Cambia la contraseña y cierra las sesiones abiertas de ese usuario. Sin `nueva`, genera una. */
export async function cambiarClave(usuario, nueva) {
  const usuarios = await leerUsuarios();
  const registro = usuarios[normalizar(usuario)];
  if (!registro) throw new Error("Ese usuario no existe.");
  const secreta = nueva ?? generarClave();
  if (String(secreta).length < CLAVE_MINIMA) throw new Error(`La contraseña debe tener al menos ${CLAVE_MINIMA} caracteres.`);
  registro.sal = randomBytes(16).toString("hex");
  registro.huella = huella(secreta, registro.sal);
  registro.version += 1;
  await guardarUsuarios(usuarios);
  return { registro, clave: secreta };
}

const administradores = (usuarios) => Object.values(usuarios).filter((r) => r.rol === "admin").length;

export async function cambiarRol(usuario, rol, quienLoPide) {
  if (!ROLES.includes(rol)) throw new Error("Rol no válido.");
  const usuarios = await leerUsuarios();
  const registro = usuarios[normalizar(usuario)];
  if (!registro) throw new Error("Ese usuario no existe.");
  if (registro.usuario === quienLoPide && rol !== "admin") throw new Error("No puedes quitarte a ti mismo el rol de administrador.");
  if (registro.rol === "admin" && rol !== "admin" && administradores(usuarios) === 1) throw new Error("Debe quedar al menos un administrador.");
  registro.rol = rol;
  registro.version += 1;
  await guardarUsuarios(usuarios);
  return publico(registro);
}

export async function eliminar(usuario, quienLoPide) {
  const usuarios = await leerUsuarios();
  const registro = usuarios[normalizar(usuario)];
  if (!registro) throw new Error("Ese usuario no existe.");
  if (registro.usuario === quienLoPide) throw new Error("No puedes eliminar tu propio usuario.");
  if (registro.rol === "admin" && administradores(usuarios) === 1) throw new Error("Debe quedar al menos un administrador.");
  delete usuarios[registro.usuario];
  await guardarUsuarios(usuarios);
}

/* ---------- Sesiones ---------- */

async function firma(datos) {
  const secreto = await secretoDeSesiones(randomBytes(32).toString("hex"));
  return createHmac("sha256", secreto).update(datos).digest("base64url");
}

/** Pone la cookie de sesión. `Secure` solo donde hay https (en local no lo hay). */
export async function abrirSesion(res, registro) {
  const datos = Buffer.from(JSON.stringify({ u: registro.usuario, v: registro.version, exp: Math.floor(Date.now() / 1000) + DURACION_SEGUNDOS })).toString("base64url");
  const cookie = `${COOKIE}=${datos}.${await firma(datos)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DURACION_SEGUNDOS}${process.env.VERCEL ? "; Secure" : ""}`;
  res.setHeader("Set-Cookie", cookie);
}

export function cerrarSesion(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.VERCEL ? "; Secure" : ""}`);
}

/** El usuario de la sesión, o null si no hay, venció, o le cambiaron la contraseña o el rol. */
export async function leerSesion(req) {
  const cookies = String(req.headers.cookie ?? "").split(";").map((c) => c.trim());
  const valor = cookies.find((c) => c.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!valor) return null;
  const [datos, firmada] = valor.split(".");
  if (!datos || !firmada) return null;
  const esperada = Buffer.from(await firma(datos));
  const recibida = Buffer.from(firmada);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  let sesion;
  try {
    sesion = JSON.parse(Buffer.from(datos, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!(sesion.exp > Date.now() / 1000)) return null;
  const registro = (await leerUsuarios())[sesion.u];
  return registro && registro.version === sesion.v ? registro : null;
}

/**
 * Exige una sesión abierta y, si se indica, uno de los roles. Responde 401 o 403 y devuelve null si no cumple.
 * @param {string[]} [roles]
 */
export async function exigirSesion(req, res, roles) {
  const registro = await leerSesion(req);
  if (!registro) {
    res.status(401).json({ error: "Inicia sesión para continuar." });
    return null;
  }
  if (roles && !roles.includes(registro.rol)) {
    res.status(403).json({ error: "Tu usuario no tiene permiso para esto." });
    return null;
  }
  return registro;
}
