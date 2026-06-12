const jwt = require('jsonwebtoken');

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
function authAdminOrComercio(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.tipo === 'admin') { req.admin = decoded; return next(); }
    if (decoded.tipo === 'comercio') {
      // Verificar que el comercio del token coincide con el solicitado
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
