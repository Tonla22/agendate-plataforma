const assert = require('assert');
const { contextoSeguro, registrarEvento } = require('../backend/services/operationalEvents');

(async () => {
  const contexto = contextoSeguro({
    estado: 500,
    activo: false,
    detalle: 'x'.repeat(500),
    extra: { token: 'no-debe-serializarse-completo' }
  });

  assert.strictEqual(contexto.estado, 500);
  assert.strictEqual(contexto.activo, false);
  assert.strictEqual(contexto.detalle.length, 300);
  assert.strictEqual(typeof contexto.extra, 'string');

  const consultas = [];
  const db = {
    query: async (sql, params) => {
      consultas.push({ sql, params });
      return { rows: [] };
    }
  };

  await registrarEvento({
    nivel: 'error',
    categoria: 'pagos',
    codigo: 'pago_rechazado',
    mensaje: 'Pago rechazado',
    contexto: { status: 'rejected' }
  }, db);

  assert.ok(consultas.some(item => item.sql.includes('INSERT INTO eventos_sistema')));
  const insercion = consultas.find(item => item.sql.includes('INSERT INTO eventos_sistema'));
  assert.strictEqual(insercion.params[0], 'error');
  assert.strictEqual(insercion.params[1], 'pagos');
  assert.strictEqual(insercion.params[2], 'pago_rechazado');
  assert.ok(insercion.sql.includes("INTERVAL '5 minutes'"));

  console.log('operational-events.test ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
