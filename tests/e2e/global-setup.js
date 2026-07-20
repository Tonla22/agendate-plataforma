const path = require('path');
const { execFileSync } = require('child_process');
const { validarBaseE2E } = require('./database-guard');

module.exports = async function globalSetup() {
  validarBaseE2E();
  const raiz = path.join(__dirname, '../..');
  const opciones = { cwd: raiz, env: process.env, stdio: 'inherit' };

  execFileSync(process.execPath, ['backend/db/init.js'], opciones);
  execFileSync(process.execPath, ['tests/e2e/fixture-db.js'], opciones);
};
