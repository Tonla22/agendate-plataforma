require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const pool = require('./db/pool');
const { crearHealthHandler } = require('./services/health');
const {
  iniciarAutomatizacionesWhatsApp
} = require('./services/whatsappAutomations');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Middlewares globales
app.use(helmet({
  contentSecurityPolicy: false
}));

const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';

app.use(cors({
  origin: allowedOrigin,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// Fuera del rate limit general para permitir comprobaciones externas frecuentes.
app.get('/api/health', crearHealthHandler({ pool }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// La portada publica debe resolverse tambien para crawlers que no ejecutan JavaScript.
app.get('/', (req, res) => res.redirect(302, '/sobre'));

app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiados intentos de login. Probá de nuevo en unos minutos.'
  }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Demasiadas solicitudes. Probá de nuevo más tarde.'
  }
});

app.use('/api/auth', authLimiter);
app.use('/api/', apiLimiter);

// Rutas API
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/comercio',require('./routes/comercio'));
app.use('/api/automatizaciones', require('./routes/automatizaciones'));
app.use('/api/pagos', require('./routes/pagos'));
app.use('/api/p',       require('./routes/publico'));

// Salud del servidor

// SPA fallback — todas las rutas van al frontend
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

  console.log(`Servidor corriendo en ${baseUrl}`);

  if (process.env.DISABLE_AUTOMATIONS !== 'true') {
    iniciarAutomatizacionesWhatsApp();
  }
});
