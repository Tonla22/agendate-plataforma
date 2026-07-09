const pool = require('../db/pool');

const {
  enviarRecordatorioReserva,
  enviarAgradecimientoReserva
} = require('./whatsapp');

let ejecutando = false;

function datosMensaje(fila) {
  return {
    reserva: {
      id: fila.reserva_id,
      uuid: fila.uuid,
      fecha: fila.fecha,
      hora: fila.hora,
      cliente_nombre: fila.cliente_nombre,
      cliente_whatsapp: fila.cliente_whatsapp
    },
    comercio: {
      id: fila.comercio_id,
      nombre: fila.comercio_nombre,
      whatsapp: fila.comercio_whatsapp,
      telefono: fila.comercio_telefono
    },
    servicio: {
      id: fila.servicio_id,
      nombre: fila.servicio_nombre
    },
    profesional: fila.profesional_nombre
      ? {
          id: fila.profesional_id,
          nombre: fila.profesional_nombre
        }
      : null
  };
}

async function procesarRecordatorios() {
  const resultado = await pool.query(`
    SELECT
      r.id AS reserva_id,
      r.uuid,
      r.fecha,
      r.hora::text AS hora,
      r.cliente_nombre,
      r.cliente_whatsapp,

      c.id AS comercio_id,
      c.nombre AS comercio_nombre,
      c.whatsapp AS comercio_whatsapp,
      c.telefono AS comercio_telefono,

      s.id AS servicio_id,
      s.nombre AS servicio_nombre,

      t.id AS profesional_id,
      t.nombre AS profesional_nombre

    FROM reservas r
    JOIN comercios c ON c.id = r.comercio_id
    JOIN servicios s ON s.id = r.servicio_id
    LEFT JOIN trabajadores t ON t.id = r.trabajador_id

    WHERE r.estado = 'confirmada'
      AND r.recordatorio_enviado = false
      AND c.activo = true
      AND c.auto_recordatorio_activo = true

      AND (r.fecha + r.hora)
          > (NOW() AT TIME ZONE 'America/Montevideo')

      AND (r.fecha + r.hora)
          <= (
            (NOW() AT TIME ZONE 'America/Montevideo')
            + make_interval(hours => c.auto_recordatorio_horas_antes)
          )

    ORDER BY r.fecha, r.hora
    LIMIT 50
  `);

  for (const fila of resultado.rows) {
    try {
      const enviado = await enviarRecordatorioReserva(datosMensaje(fila));

      if (!enviado) continue;

      await pool.query(
        `UPDATE reservas
         SET recordatorio_enviado = true,
             recordatorio_enviado_en = NOW()
         WHERE id = $1
           AND recordatorio_enviado = false`,
        [fila.reserva_id]
      );

      console.log(`Recordatorio WhatsApp enviado: reserva ${fila.reserva_id}`);
    } catch (error) {
      console.error(
        `No se pudo enviar recordatorio de reserva ${fila.reserva_id}:`,
        error.message
      );
    }
  }
}

async function procesarAgradecimientos() {
  const resultado = await pool.query(`
    SELECT
      r.id AS reserva_id,
      r.uuid,
      r.fecha,
      r.hora::text AS hora,
      r.duracion_min,
      r.cliente_nombre,
      r.cliente_whatsapp,

      c.id AS comercio_id,
      c.nombre AS comercio_nombre,
      c.whatsapp AS comercio_whatsapp,
      c.telefono AS comercio_telefono,

      s.id AS servicio_id,
      s.nombre AS servicio_nombre,

      t.id AS profesional_id,
      t.nombre AS profesional_nombre

    FROM reservas r
    JOIN comercios c ON c.id = r.comercio_id
    JOIN servicios s ON s.id = r.servicio_id
    LEFT JOIN trabajadores t ON t.id = r.trabajador_id

    WHERE r.estado = 'completada'
      AND r.agradecimiento_enviado = false
      AND c.activo = true
      AND c.auto_agradecimiento_activo = true

      AND (
        r.fecha
        + r.hora
        + make_interval(mins => r.duracion_min)
        + make_interval(hours => c.auto_agradecimiento_horas_despues)
      ) <= (NOW() AT TIME ZONE 'America/Montevideo')

    ORDER BY r.fecha, r.hora
    LIMIT 50
  `);

  for (const fila of resultado.rows) {
    try {
      const enviado = await enviarAgradecimientoReserva(datosMensaje(fila));

      if (!enviado) continue;

      await pool.query(
        `UPDATE reservas
         SET agradecimiento_enviado = true,
             agradecimiento_enviado_en = NOW()
         WHERE id = $1
           AND agradecimiento_enviado = false`,
        [fila.reserva_id]
      );

      console.log(`Agradecimiento WhatsApp enviado: reserva ${fila.reserva_id}`);
    } catch (error) {
      console.error(
        `No se pudo enviar agradecimiento de reserva ${fila.reserva_id}:`,
        error.message
      );
    }
  }
}

async function ejecutarAutomatizacionesWhatsApp() {
  if (ejecutando) return;

  ejecutando = true;

  try {
    await procesarRecordatorios();
    await procesarAgradecimientos();
  } catch (error) {
    console.error('Error procesando automatizaciones WhatsApp:', error.message);
  } finally {
    ejecutando = false;
  }
}

function iniciarAutomatizacionesWhatsApp() {
  if (process.env.WHATSAPP_AUTOMATIONS_ENABLED !== 'true') {
    console.log('Automatizaciones WhatsApp desactivadas');
    return;
  }

  const intervalo = Number(
    process.env.WHATSAPP_AUTOMATION_INTERVAL_MS || 60000
  );

  console.log(
    `Automatizaciones WhatsApp activadas cada ${intervalo} milisegundos`
  );

  const inicio = setTimeout(ejecutarAutomatizacionesWhatsApp, 10000);
  inicio.unref?.();

  const temporizador = setInterval(
    ejecutarAutomatizacionesWhatsApp,
    intervalo
  );

  temporizador.unref?.();
}

module.exports = {
  iniciarAutomatizacionesWhatsApp,
  ejecutarAutomatizacionesWhatsApp
};