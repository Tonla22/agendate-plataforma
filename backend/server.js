require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares globales
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, '../frontend')));

// Rate limiting en endpoints de reserva y auth
const limiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true });
app.use('/api/auth', limiter);
app.use('/api/p', rateLimit({ windowMs: 15*60*1000, max: 200 }));

// Rutas API
app.use('/api/auth',    require('./routes/auth'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/comercio',require('./routes/comercio'));
app.use('/api/p',       require('./routes/publico'));

// Salud del servidor
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date() }));

// SPA fallback — todas las rutas van al frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
});
