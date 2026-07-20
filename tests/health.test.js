const assert = require('assert');
const { crearHealthHandler } = require('../backend/services/health');

function crearRespuesta() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    set(nombre, valor) {
      this.headers[nombre] = valor;
      return this;
    },
    status(codigo) {
      this.statusCode = codigo;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

(async () => {
  const respuestaOk = crearRespuesta();
  const handlerOk = crearHealthHandler({
    pool: { query: async () => ({ rows: [{ ok: 1 }] }) },
    getUptime: () => 125.9
  });

  await handlerOk({}, respuestaOk);

  assert.strictEqual(respuestaOk.statusCode, 200);
  assert.strictEqual(respuestaOk.body.ok, true);
  assert.strictEqual(respuestaOk.body.status, 'healthy');
  assert.strictEqual(respuestaOk.body.checks.server, 'ok');
  assert.strictEqual(respuestaOk.body.checks.database, 'ok');
  assert.strictEqual(respuestaOk.body.uptime_seconds, 125);
  assert.strictEqual(respuestaOk.headers['Cache-Control'], 'no-store');

  const respuestaError = crearRespuesta();
  const handlerError = crearHealthHandler({
    pool: { query: async () => { throw new Error('secret_connection_detail'); } },
    getUptime: () => 12
  });
  const consoleErrorOriginal = console.error;
  console.error = () => {};

  try {
    await handlerError({}, respuestaError);
  } finally {
    console.error = consoleErrorOriginal;
  }

  assert.strictEqual(respuestaError.statusCode, 503);
  assert.strictEqual(respuestaError.body.ok, false);
  assert.strictEqual(respuestaError.body.status, 'unhealthy');
  assert.strictEqual(respuestaError.body.checks.server, 'ok');
  assert.strictEqual(respuestaError.body.checks.database, 'error');
  assert.ok(!JSON.stringify(respuestaError.body).includes('secret_connection_detail'));

  console.log('health.test ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
