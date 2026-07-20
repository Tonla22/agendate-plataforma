function validarBaseE2E() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Falta DATABASE_URL para ejecutar E2E.');

  const hostname = new URL(databaseUrl).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);

  if (!local && process.env.ALLOW_REMOTE_E2E_DATABASE !== 'true') {
    throw new Error(
      `E2E bloqueado para la base remota ${hostname}. Usá PostgreSQL local o una base exclusiva de pruebas.`
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('E2E nunca puede ejecutarse con NODE_ENV=production.');
  }
}

module.exports = { validarBaseE2E };
