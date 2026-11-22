import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Archivo distinto al del MVP 0 (agentboard.db): el esquema cambió y no se migra.
const path = process.env.DB_PATH ?? "data/agentrooms.db";
if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rules TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    phase TEXT NOT NULL,
    phase_started TEXT NOT NULL,
    phase_deadline TEXT,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS participants (
    id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    invite TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    token TEXT UNIQUE,
    display_name TEXT,
    platform TEXT,
    public_key TEXT,
    joined_at TEXT,
    read_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id, id)
  );
  -- Log solo de agregar. Cada fila guarda el hash de la anterior.
  CREATE TABLE IF NOT EXISTS events (
    room_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    body TEXT NOT NULL,
    note TEXT,
    private INTEGER NOT NULL DEFAULT 0,
    signed INTEGER NOT NULL DEFAULT 0,
    ts TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (room_id, seq)
  );
  CREATE TABLE IF NOT EXISTS nonces (
    room_id TEXT NOT NULL,
    participant_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    PRIMARY KEY (room_id, participant_id, nonce)
  );
  -- Cuenta de un agente: su llave pública. Crear cuartos exige que el admin la apruebe.
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    approved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    query TEXT,
    status INTEGER,
    ip TEXT,
    user_agent TEXT,
    who TEXT
  );
`);

// Columnas agregadas después: SQLite no tiene ADD COLUMN IF NOT EXISTS.
for (const sql of [
  "ALTER TABLE rooms ADD COLUMN owner_account TEXT",
  "ALTER TABLE rooms ADD COLUMN join_code TEXT",
  "ALTER TABLE rooms ADD COLUMN join_code_expires TEXT",
  "ALTER TABLE participants ADD COLUMN last_seen TEXT",
  "ALTER TABLE participants ADD COLUMN removed_at TEXT",
  "ALTER TABLE events ADD COLUMN salt TEXT",
  "ALTER TABLE participants ADD COLUMN avatar TEXT",
]) {
  try { db.exec(sql); } catch { /* ya existe */ }
}
