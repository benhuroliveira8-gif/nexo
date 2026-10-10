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
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Cria as tabelas. Tenta de novo por alguns segundos enquanto o Postgres sobe.
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(schema);
      return;
    } catch (err) {
      if (attempt >= 15) throw err;
      console.log(`Banco ainda não está pronto (${err.code || err.message}), tentando de novo...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { pool, query, transaction, init };
