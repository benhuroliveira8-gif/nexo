const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

const query = (text, params) => pool.query(text, params);

// Executa uma função dentro de uma transação (BEGIN/COMMIT/ROLLBACK).
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Aplica, em ordem, os arquivos de src/migrations que ainda não rodaram.
// Cada migração roda numa transação: ou entra inteira, ou não entra nada.
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    await transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(4242)'); // evita duas instâncias migrando juntas
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (done.rowCount > 0) return;
      console.log(`Aplicando migração ${file}...`);
      await c.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
  }
}

// Prepara o banco. Tenta de novo por alguns segundos enquanto o Postgres sobe.
async function init() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= 15) throw err;
      console.log(`Banco ainda não está pronto (${err.code || err.message}), tentando de novo...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  await migrate();
}

module.exports = { pool, query, transaction, init };
