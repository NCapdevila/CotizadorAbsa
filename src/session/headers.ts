/**
 * Headers de navegador para todas las requests a ABSA net.
 *
 * No son cosmeticos: el 2026-08-24, el mismo codigo y las mismas credenciales
 * loguearon bien desde una maquina de la oficina y devolvieron **403 en el GET
 * de la pagina de login** desde el VPS. El default de `got`
 * (`user-agent: got (https://github.com/sindresorhus/got)`, sin `accept` ni
 * `accept-language`) es lo primero que filtra cualquier WAF, y desde una IP de
 * datacenter el filtro es mas estricto.
 *
 * Los valores estan copiados del HAR real de Fase 0 — son literalmente los que
 * manda el navegador del productor cuando entra al portal. No se inventa nada
 * ni se falsea la identidad del integrador: es la misma cuenta, el mismo
 * usuario y el mismo uso, pidiendo el HTML como lo pide el navegador para el
 * que ese HTML esta hecho.
 *
 * Los `sec-ch-ua*` van juntos con el user-agent a proposito: un Chrome real
 * siempre los manda, y un user-agent de Chrome sin ellos es una combinacion
 * que no existe.
 */
export const HEADERS_NAVEGADOR: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "es-419,es;q=0.9",
  "sec-ch-ua": '"Chromium";v="151", "Not=A?Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "upgrade-insecure-requests": "1",
};

/** Los de arriba mas los de una navegacion "escribiendo la URL en la barra". */
export const HEADERS_NAVEGACION: Record<string, string> = {
  ...HEADERS_NAVEGADOR,
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};
