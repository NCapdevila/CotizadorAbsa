import fs from "node:fs";
import path from "node:path";
import type { SessionArtifact } from "./types.js";
import { logger } from "../logger.js";

/**
 * Persistencia simple en disco del artefacto de sesion, para no tener que
 * hacer login de nuevo en cada arranque del proceso. Es deliberadamente
 * un JSON plano en filesystem local — si esto corre como servicio con
 * multiples instancias, reemplazar por algo compartido (Redis, etc).
 *
 * El archivo contiene cookies de sesion reales: mismo trato que un secreto.
 * Ya esta cubierto por .gitignore (".session/", "*.session.json").
 */
export class SessionStore {
  constructor(private readonly filePath: string) {}

  load(): SessionArtifact | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as SessionArtifact;
    } catch (err) {
      logger.warn({ err }, "No se pudo leer la sesion persistida, se ignora y se relogueara");
      return null;
    }
  }

  save(artifact: SessionArtifact): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(artifact, null, 2), {
      mode: 0o600,
    });
  }

  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch (err) {
      logger.warn({ err }, "No se pudo borrar la sesion persistida");
    }
  }
}
