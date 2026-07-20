const pool = require('../../backend/db/pool');
const { validarBaseE2E } = require('./database-guard');

async function preparar() {
  validarBaseE2E();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM comercios WHERE slug='e2e-reservas'");

    const comercio = await client.query(`
      INSERT INTO comercios (
        slug, nombre, slogan, moneda, activo,
        auto_confirmacion_activa, auto_recordatorio_activo,
        auto_cancelacion_activa, auto_agradecimiento_activo,
        pago_mercadopago_activo
      ) VALUES (
        'e2e-reservas', 'Comercio E2E', 'Pruebas automatizadas', '$', true,
        false, false, false, false, false
      ) RETURNING id
    `);
    const comercioId = comercio.rows[0].id;

    await client.query(`
      INSERT INTO servicios (
        comercio_id, nombre, descripcion, precio, duracion_min,
        activo, requiere_sena, orden
      ) VALUES ($1, 'Reserva E2E sin pago', 'Servicio exclusivo de pruebas', 100, 30, true, false, 1)
    `, [comercioId]);

    for (let dia = 0; dia <= 6; dia++) {
      await client.query(`
        INSERT INTO horarios (comercio_id, dia_semana, abre, cierra, activo)
        VALUES ($1, $2, '08:00', '22:00', true)
      `, [comercioId, dia]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

preparar().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
