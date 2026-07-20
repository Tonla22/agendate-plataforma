const HEALTHCHECK_TIMEOUT_MS = 3000;

async function comprobarBaseDatos(pool, timeoutMs = HEALTHCHECK_TIMEOUT_MS) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('database_timeout')), timeoutMs);
  });

  try {
    await Promise.race([pool.query('SELECT 1 AS ok'), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function crearHealthHandler({ pool, getUptime = () => process.uptime() }) {
  return async (req, res) => {
    const inicio = Date.now();
    const timestamp = new Date().toISOString();

    res.set('Cache-Control', 'no-store');

    try {
      await comprobarBaseDatos(pool);

      return res.status(200).json({
        ok: true,
        status: 'healthy',
        timestamp,
        uptime_seconds: Math.floor(getUptime()),
        checks: { server: 'ok', database: 'ok' },
        database_latency_ms: Date.now() - inicio
      });
    } catch (error) {
      console.error('Health check de base de datos fallido:', error.message);

      return res.status(503).json({
        ok: false,
        status: 'unhealthy',
        timestamp,
        uptime_seconds: Math.floor(getUptime()),
        checks: { server: 'ok', database: 'error' }
      });
    }
  };
}

module.exports = {
  HEALTHCHECK_TIMEOUT_MS,
  comprobarBaseDatos,
  crearHealthHandler
};
