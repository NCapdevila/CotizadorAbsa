/**
 * Parseo de `--flag valor` compartido por los CLIs (`cotizar`, `versiones`).
 *
 * Toma TODAS las palabras hasta el proximo `--`, no solo la primera. Sin esto,
 * `--modelo TRACKER 1.2T AT PREMIER` (sin comillas, que es como se escribe en
 * la practica) se leia como `--modelo TRACKER` y el resto se perdia en
 * silencio: ABSA terminaba buscando solo "CHEVROLET TRACKER" y cotizando
 * cualquier version del modelo.
 */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const valores: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      valores.push(argv[++i]!);
    }
    out[key] = valores.length > 0 ? valores.join(" ") : "true";
  }
  return out;
}
