const express = require('express');
const router = express.Router();
const db = require('../db');

// GET /api/p/:slug — datos públicos de un comercio (para cargar la página)
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, slug, nombre, slogan, tipo, telefono, whatsapp, email,
             direccion, instagram_url, logo_url, moneda,
             color_acento, color_fondo, color_tarjeta, color_texto
      FROM comercios WHERE slug = $1 AND activo = TRUE
    `, [req.params.slug]);

    if (!rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    const c = rows[0];

    const [horarios, servicios] = await Promise.all([
      db.query(`SELECT dia, abre, cierra, cerrado FROM horarios
                WHERE comercio_id = $1 ORDER BY CASE dia
                  WHEN 'Lunes' THEN 1 WHEN 'Martes' THEN 2 WHEN 'Miércoles' THEN 3
                  WHEN 'Jueves' THEN 4 WHEN 'Viernes' THEN 5
                  WHEN 'Sábado' THEN 6 WHEN 'Domingo' THEN 7 END`, [c.id]),
      db.query(`SELECT id, nombre, descripcion, precio, duracion_min
                FROM servicios WHERE comercio_id = $1 AND activo = TRUE
                ORDER BY orden, nombre`, [c.id]),
    ]);

    res.json({ comercio: c, horarios: horarios.rows, servicios: servicios.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/p/:slug/disponibilidad?fecha=2025-03-15&servicio_id=xxx
router.get('/:slug/disponibilidad', async (req, res) => {
  try {
    const { fecha, servicio_id } = req.query;
    if (!fecha || !servicio_id) return res.status(400).json({ error: 'Faltan parámetros' });

    // Obtener comercio y servicio
    const [comRes, svcRes] = await Promise.all([
      db.query('SELECT id FROM comercios WHERE slug = $1 AND activo = TRUE', [req.params.slug]),
      db.query('SELECT duracion_min FROM servicios WHERE id = $1', [servicio_id]),
    ]);
    if (!comRes.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });
    if (!svcRes.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });

    const comercio_id = comRes.rows[0].id;
    const duracion = svcRes.rows[0].duracion_min;

    // Día de la semana
    const fecha_obj = new Date(fecha + 'T12:00:00');
    const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
    const diaNombre = dias[fecha_obj.getDay()];

    const horarioRes = await db.query(
      'SELECT abre, cierra, cerrado FROM horarios WHERE comercio_id = $1 AND dia = $2',
      [comercio_id, diaNombre]
    );
    if (!horarioRes.rows[0] || horarioRes.rows[0].cerrado) {
      return res.json({ disponibles: [] });
    }

    // Generar slots
    const { abre, cierra } = horarioRes.rows[0];
    const slots = generarSlots(abre, cierra, duracion);

    // Reservas existentes ese día
    const reservasRes = await db.query(`
      SELECT hora_inicio, hora_fin FROM reservas
      WHERE comercio_id = $1 AND fecha = $2 AND estado != 'cancelada'
    `, [comercio_id, fecha]);

    const ocupados = reservasRes.rows.map(r => ({
      inicio: timeToMin(r.hora_inicio),
      fin: timeToMin(r.hora_fin),
    }));

    const disponibles = slots.filter(slot => {
      const slotInicio = timeToMin(slot);
      const slotFin = slotInicio + duracion;
      return !ocupados.some(o => slotInicio < o.fin && slotFin > o.inicio);
    });

    res.json({ disponibles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/p/:slug/reservar
router.post('/:slug/reservar', async (req, res) => {
  try {
    const { servicio_id, fecha, hora, cliente_nombre, cliente_wa, cliente_email, comentarios } = req.body;

    // Validaciones básicas
    if (!servicio_id || !fecha || !hora || !cliente_nombre || !cliente_wa) {
      return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }

    const comRes = await db.query(
      'SELECT id, nombre, whatsapp FROM comercios WHERE slug = $1 AND activo = TRUE',
      [req.params.slug]
    );
    if (!comRes.rows[0]) return res.status(404).json({ error: 'Comercio no encontrado' });

    const svcRes = await db.query(
      'SELECT * FROM servicios WHERE id = $1 AND comercio_id = $2 AND activo = TRUE',
      [servicio_id, comRes.rows[0].id]
    );
    if (!svcRes.rows[0]) return res.status(404).json({ error: 'Servicio no encontrado' });

    const comercio = comRes.rows[0];
    const servicio = svcRes.rows[0];

    // Calcular hora_fin
    const horaFinStr = addMinutes(hora, servicio.duracion_min);

    // Verificar que el slot sigue disponible (evitar doble booking)
    const solapado = await db.query(`
      SELECT id FROM reservas
      WHERE comercio_id = $1 AND fecha = $2 AND estado != 'cancelada'
        AND hora_inicio < $3 AND hora_fin > $4
    `, [comercio.id, fecha, horaFinStr, hora]);

    if (solapado.rows.length > 0) {
      return res.status(409).json({ error: 'Ese horario ya fue reservado. Elegí otro.' });
    }

    // Crear reserva
    const { rows } = await db.query(`
      INSERT INTO reservas (
        comercio_id, servicio_id, cliente_nombre, cliente_wa, cliente_email,
        comentarios, fecha, hora_inicio, hora_fin, precio,
        ip_origen
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [
      comercio.id, servicio_id, cliente_nombre, cliente_wa, cliente_email||null,
      comentarios||null, fecha, hora, horaFinStr, servicio.precio,
      req.ip
    ]);

    res.status(201).json({
      ok: true,
      reserva_id: rows[0].id,
      mensaje: `Turno confirmado para el ${fecha} a las ${hora}hs`,
      datos: {
        servicio: servicio.nombre,
        precio: servicio.precio,
        fecha,
        hora,
        hora_fin: horaFinStr,
        cliente: cliente_nombre,
        whatsapp_negocio: comercio.whatsapp,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Helpers ----
function timeToMin(t) {
  if (!t) return 0;
  const str = typeof t === 'string' ? t : t.toString();
  const parts = str.slice(0,5).split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

function minToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function addMinutes(time, mins) {
  return minToTime(timeToMin(time) + mins);
}

function generarSlots(abre, cierra, duracion) {
  const slots = [];
  let cur = timeToMin(abre);
  const end = timeToMin(cierra);
  while (cur + duracion <= end) {
    slots.push(minToTime(cur));
    cur += duracion;
  }
  return slots;
}

module.exports = router;
