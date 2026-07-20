const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function globalTeardown() {
  const raiz = path.join(__dirname, '../..');
  execFileSync(process.execPath, ['tests/e2e/cleanup-db.js'], {
    cwd: raiz,
    env: process.env,
    stdio: 'inherit'
  });
};
