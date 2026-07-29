const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Middleware para super-admin
function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tipo !== 'admin') return res.status(403).json({ error: 'No autorizado' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Middleware para dueño de comercio
function authComercio(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tipo !== 'comercio') return res.status(403).json({ error: 'No autorizado' });
    req.usuario = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Puede ser admin O dueño del comercio correcto
async function authAdminOrComercio(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tipo === 'admin') { req.admin = decoded; return next(); }
    if (decoded.tipo === 'comercio') {
      // Verificar que el comercio del token coincide con el solicitado
      if (!req.baseUrl.startsWith('/api/suscripciones')) {
        const acceso = await pool.query(`
          SELECT (
            suscripcion_estado='pausada'
            OR (
              suscripcion_estado='pago_pendiente'
              AND suscripcion_tolerancia_hasta IS NOT NULL
              AND suscripcion_tolerancia_hasta < CURRENT_DATE
            )
            OR (
              suscripcion_estado='cancelada'
              AND fecha_pago_hasta IS NOT NULL
              AND fecha_pago_hasta < CURRENT_DATE
            )
          ) AS restringido
          FROM comercios
          WHERE id=$1
        `, [decoded.comercio_id]);

        if (acceso.rows[0]?.restringido) {
          return res.status(402).json({
            error: 'La mensualidad de Agendate requiere regularizacion',
            code: 'SUBSCRIPTION_REQUIRED'
          });
        }
      }

      const slugParam = req.params.slug || req.body.slug;
      if (slugParam && decoded.slug !== slugParam && !decoded.supercomercio) {
        return res.status(403).json({ error: 'No podés acceder a este comercio' });
      }
      req.usuario = decoded;
      return next();
    }
    res.status(403).json({ error: 'No autorizado' });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

module.exports = { authAdmin, authComercio, authAdminOrComercio };
