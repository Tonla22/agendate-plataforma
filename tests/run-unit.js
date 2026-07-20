const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = __dirname;
const archivos = fs.readdirSync(testsDir)
  .filter(nombre => nombre.endsWith('.test.js'))
  .sort();

for (const archivo of archivos) {
  const resultado = spawnSync(process.execPath, [path.join(testsDir, archivo)], {
    stdio: 'inherit'
  });

  if (resultado.status !== 0) process.exit(resultado.status || 1);
}

console.log(`${archivos.length} pruebas unitarias completadas`);
