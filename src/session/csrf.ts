import * as cheerio from "cheerio";

/**
 * ABSA net (ASP.NET MVC) protege cada POST con el token anti-forgery
 * estandar de MVC (`@Html.AntiForgeryToken()`), embebido como
 * `<input type="hidden" name="__RequestVerificationToken">` en el HTML de
 * la pagina. No viaja en un header ni en una cookie separada -- hay que
 * hacer un GET a la pagina del form y extraerlo de ahi antes de cualquier
 * POST (ver docs/absa-endpoints.md seccion 2).
 */
export function extractRequestVerificationToken(html: string): string {
  const $ = cheerio.load(html);
  const token = $('input[name="__RequestVerificationToken"]').attr("value");
  if (!token) {
    throw new Error(
      "No se encontro __RequestVerificationToken en la pagina. " +
        "Puede que ABSA net haya cambiado el mecanismo de CSRF, o que la sesion " +
        "no este autenticada (revisar si la respuesta es en realidad una pagina de login).",
    );
  }
  return token;
}
