require('dotenv').config({ path: require('path').join(__dirname, '../../backend/.env') });
const pool = require('../../backend/db/pool');
const { validarBaseE2E } = require('./database-guard');

async function limpiar() {
  validarBaseE2E();
  await pool.query("DELETE FROM comercios WHERE slug='e2e-reservas'");
  await pool.end();
}

limpiar().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
