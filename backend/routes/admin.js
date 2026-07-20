const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { authAdmin } = require('../middleware/auth');

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// GET /api/admin/comercios — listar todos
router.get('/comercios', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, 
        COUNT(DISTINCT s.id) as total_servicios,
        COUNT(DISTINCT res.id) as total_reservas,
        COUNT(DISTINCT uc.id) as total_usuarios
      FROM comercios c
      LEFT JOIN servicios s ON s.comercio_id=c.id
      LEFT JOIN reservas res ON res.comercio_id=c.id
      LEFT JOIN usuarios_comercio uc ON uc.comercio_id=c.id
      GROUP BY c.id ORDER BY c.creado_en DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/stats — métricas globales
router.get('/stats', authAdmin, async (req, res) => {
  try {
    const [comercios, reservas, hoy] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM comercios WHERE activo=true'),
      pool.query('SELECT COUNT(*) FROM reservas WHERE estado=\'confirmada\''),
      pool.query('SELECT COUNT(*) FROM reservas WHERE fecha=CURRENT_DATE AND estado=\'confirmada\'')
    ]);
    res.json({
      comercios_activos: parseInt(comercios.rows[0].count),
      total_reservas: parseInt(reservas.rows[0].count),
      reservas_hoy: parseInt(hoy.rows[0].count)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/sistema - estado operativo global
router.get('/sistema', authAdmin, async (req, res) => {
  const inicio = Date.now();

  try {
    const [
      relojDb,
      eventosResumen,
      eventosRecientes,
      pagos,
      calendar,
      actividad
    ] = await Promise.all([
      pool.query('SELECT NOW() AS ahora'),
      pool.query(`
        SELECT nivel, categoria, COUNT(*)::integer AS total
        FROM eventos_sistema
        WHERE creado_en >= NOW() - INTERVAL '24 hours'
        GROUP BY nivel, categoria
        ORDER BY nivel, categoria
      `),
      pool.query(`
        SELECT e.id,e.nivel,e.categoria,e.codigo,e.mensaje,e.contexto,e.creado_en,
               c.nombre AS comercio_nombre
        FROM eventos_sistema e
        LEFT JOIN comercios c ON c.id=e.comercio_id
        ORDER BY e.creado_en DESC
        LIMIT 40
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE estado_pago='pagado' AND pagada_en >= NOW() - INTERVAL '24 hours')::integer AS aprobados_24h,
          COUNT(*) FILTER (WHERE mercadopago_status IN ('rejected','cancelled','cancelled_by_user','charged_back') AND creado_en >= NOW() - INTERVAL '24 hours')::integer AS fallidos_24h,
          COUNT(*) FILTER (WHERE estado='pendiente' AND estado_pago='pendiente' AND pago_retencion_vence_en > NOW())::integer AS pendientes_activos,
          COUNT(*) FILTER (WHERE estado_pago='expirado' AND pago_retencion_expirada_en >= NOW() - INTERVAL '24 hours')::integer AS vencidos_24h,
          MAX(pagada_en) AS ultimo_pago_aprobado
        FROM reservas
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE google_calendar_access_token IS NOT NULL)::integer AS comercios_conectados,
          (SELECT COUNT(*)::integer FROM reservas WHERE google_calendar_sync_error IS NOT NULL) AS errores_pendientes
        FROM comercios
        WHERE activo=true
      `),
      pool.query(`
        SELECT
          MAX(creado_en) AS ultima_reserva,
          COUNT(*) FILTER (WHERE creado_en >= NOW() - INTERVAL '24 hours')::integer AS reservas_24h
        FROM reservas
      `)
    ]);

    const resumen = eventosResumen.rows.reduce((acc, fila) => {
      acc.total += fila.total;
      acc.por_nivel[fila.nivel] = (acc.por_nivel[fila.nivel] || 0) + fila.total;
      acc.por_categoria[fila.categoria] = (acc.por_categoria[fila.categoria] || 0) + fila.total;
      return acc;
    }, { total: 0, por_nivel: {}, por_categoria: {} });

    res.json({
      status: resumen.por_nivel.critical || resumen.por_nivel.error ? 'attention' : 'healthy',
      checked_at: new Date().toISOString(),
      release: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || null,
      server: { status: 'ok', uptime_seconds: Math.floor(process.uptime()) },
      database: {
        status: 'ok',
        latency_ms: Date.now() - inicio,
        timestamp: relojDb.rows[0].ahora
      },
      integrations: {
        mercadopago: pagos.rows[0],
        google_calendar: calendar.rows[0],
        whatsapp: {
          configured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
          errors_24h: resumen.por_categoria.whatsapp || 0
        }
      },
      activity: actividad.rows[0],
      events_24h: resumen,
      recent_events: eventosRecientes.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'No se pudo consultar el estado del sistema' });
  }
});

// POST /api/admin/comercios — crear nuevo comercio
router.post('/comercios', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      slug, nombre, slogan, telefono, whatsapp, email_contacto,
      email_notificaciones, direccion, instagram_url, color_acento,
      color_fondo, moneda, duracion_turno_min, webhook_url,
      // Dueño
      dueno_nombre, dueno_email, dueno_password,
      // Servicios iniciales
      servicios = [],
      // Horarios iniciales
      horarios = []
    } = req.body;

    const slugNormalizado = String(slug || '').trim().toLowerCase();
    const duenoEmailNormalizado = normalizarEmail(dueno_email);
    const duenoPassword = String(dueno_password || '');
    const duenoNombre = String(dueno_nombre || nombre || '').trim();

    // Validar slug único y formato
    if (!/^[a-z0-9-]+$/.test(slugNormalizado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El slug solo puede tener letras minúsculas, números y guiones' });
    }

    const slugExiste = await client.query('SELECT id FROM comercios WHERE slug=$1', [slugNormalizado]);
    if (slugExiste.rows[0]) await client.query('ROLLBACK');
    if (slugExiste.rows[0]) return res.status(400).json({ error: 'Ese slug ya está en uso' });

    if (!duenoEmailNormalizado || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(duenoEmailNormalizado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'El email del dueno no es valido' });
    }

    if (duenoPassword.length < 6 || duenoPassword.length > 100) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'La contrasena del dueno debe tener entre 6 y 100 caracteres' });
    }

    const emailExiste = await client.query(
      'SELECT id FROM usuarios_comercio WHERE LOWER(TRIM(email))=$1 LIMIT 1',
      [duenoEmailNormalizado]
    );
    if (emailExiste.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Ese email ya esta registrado para otro comercio' });
    }

    // Crear comercio
    const c = await client.query(`
      INSERT INTO comercios (slug,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
        direccion,instagram_url,color_acento,color_fondo,moneda,duracion_turno_min,webhook_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [slugNormalizado,nombre,slogan,telefono,whatsapp,email_contacto,email_notificaciones,
       direccion,instagram_url,color_acento||'#C9A84C',color_fondo||'#0D0D0D',
       moneda||'$',duracion_turno_min||30,webhook_url]
    );
    const comercioId = c.rows[0].id;

    // Crear usuario dueño
    const hash = await bcrypt.hash(duenoPassword, 10);
    await client.query(
      'INSERT INTO usuarios_comercio (comercio_id,email,password_hash,nombre,rol) VALUES ($1,$2,$3,$4,$5)',
      [comercioId, duenoEmailNormalizado, hash, duenoNombre || nombre, 'dueno']
    );

    // Insertar servicios
    for (const s of servicios) {
      await client.query(
        'INSERT INTO servicios (comercio_id,nombre,precio,duracion_min,orden) VALUES ($1,$2,$3,$4,$5)',
        [comercioId, s.nombre, s.precio, s.duracion_min, s.orden||0]
      );
    }

    // Insertar horarios
    for (const h of horarios) {
      if (h.activo && h.abre && h.cierra) {
        await client.query(
          'INSERT INTO horarios (comercio_id,dia_semana,abre,cierra,activo) VALUES ($1,$2,$3,$4,true)',
          [comercioId, h.dia_semana, h.abre, h.cierra]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ...c.rows[0], mensaje: 'Comercio creado correctamente' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PUT /api/admin/comercios/:id — editar comercio
router.put('/comercios/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const campos = ['nombre','slogan','telefono','whatsapp','email_contacto','email_notificaciones',
      'direccion','instagram_url','color_acento','color_fondo','moneda','duracion_turno_min',
      'webhook_url','activo','plan','fecha_pago_hasta'];
    const sets = []; const vals = [];
    campos.forEach(c => {
      if (req.body[c] !== undefined) { sets.push(`${c}=$${sets.length+1}`); vals.push(req.body[c]); }
    });
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });
    vals.push(id);
    sets.push(`actualizado_en=NOW()`);
    const r = await pool.query(`UPDATE comercios SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/comercios/:id
router.delete('/comercios/:id', authAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM comercios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/comercios/:id/reservas
router.get('/comercios/:id/reservas', authAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*, s.nombre as servicio_nombre, s.precio
      FROM reservas r JOIN servicios s ON s.id=r.servicio_id
      WHERE r.comercio_id=$1 ORDER BY r.fecha DESC, r.hora DESC
    `, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/reservas — todas las reservas de todos los comercios
router.get('/reservas', authAdmin, async (req, res) => {
  try {
    const { desde, hasta } = req.query;

    const where = [];
    const vals = [];

    if (desde) {
      vals.push(desde);
      where.push(`r.fecha >= $${vals.length}`);
    }

    if (hasta) {
      vals.push(hasta);
      where.push(`r.fecha <= $${vals.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(`
      SELECT 
        r.*,
        c.nombre AS comercio_nombre,
        c.slug AS comercio_slug,
        s.nombre AS servicio_nombre,
        s.precio
      FROM reservas r
      JOIN comercios c ON c.id = r.comercio_id
      JOIN servicios s ON s.id = r.servicio_id
      ${whereSql}
      ORDER BY r.fecha DESC, r.hora DESC
      LIMIT 500
    `, vals);

    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/configuracion - configuración general de Agendate
router.get('/configuracion', authAdmin, async (req, res) => {
  try {
    const resultado = await pool.query(
      `SELECT logo_url, actualizado_en
       FROM configuracion_plataforma
       WHERE id=1`
    );

    res.json(
      resultado.rows[0] || {
        logo_url: null,
        actualizado_en: null
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/configuracion - guardar logo general
router.put('/configuracion', authAdmin, async (req, res) => {
  try {
    const logoUrl = String(req.body.logo_url || '').trim();

    if (
      logoUrl &&
      (
        logoUrl.length > 500 ||
        !logoUrl.startsWith('https://res.cloudinary.com/')
      )
    ) {
      return res.status(400).json({
        error: 'La URL del logo no es válida'
      });
    }

    const resultado = await pool.query(
      `INSERT INTO configuracion_plataforma
        (id, logo_url, actualizado_en)
       VALUES (1, $1, NOW())

       ON CONFLICT (id)
       DO UPDATE SET
         logo_url=EXCLUDED.logo_url,
         actualizado_en=NOW()

       RETURNING logo_url, actualizado_en`,
      [logoUrl || null]
    );

    res.json({
      ok: true,
      configuracion: resultado.rows[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
