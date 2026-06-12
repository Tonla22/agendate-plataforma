require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  console.log('🗄️  Ejecutando migración...');
  
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅ Schema creado');

  // Crear admin por defecto
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@agendate.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(adminPass, 12);
  
  await pool.query(`
    INSERT INTO admins (email, password, nombre)
    VALUES ($1, $2, 'Administrador')
    ON CONFLICT (email) DO NOTHING
  `, [adminEmail, hash]);
  
  console.log(`✅ Admin creado: ${adminEmail}`);
  console.log('🎉 Migración completa');
  await pool.end();
}

migrate().catch(err => {
  console.error('❌ Error en migración:', err);
  process.exit(1);
});
