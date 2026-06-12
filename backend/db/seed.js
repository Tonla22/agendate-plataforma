// backend/db/seed.js
// Crea el superadmin y un comercio de ejemplo
// Correr con: npm run db:seed

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function seed() {
  try {
    // 1. Superadmin
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin1234!', 12);
    await pool.query(`
      INSERT INTO usuarios (email, password_hash, nombre, rol)
      VALUES ($1, $2, 'Super Admin', 'superadmin')
      ON CONFLICT (email) DO NOTHING
    `, [process.env.ADMIN_EMAIL || 'admin@agendate.com', hash]);

    // 2. Comercio demo
    const [{ id: comercioId }] = (await pool.query(`
      INSERT INTO comercios (slug, nombre, slogan, telefono, whatsapp, email_contacto, email_notif, direccion, moneda)
      VALUES ('mc-barber-studio', 'MC Barber Studio', 'El arte del buen corte', '+598 99 111 222', '59899111222', 'info@mcbarber.com', 'info@mcbarber.com', 'Av. Italia 1234, Montevideo', '$')
      ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
      RETURNING id
    `)).rows;

    // Horarios demo (lun-sab)
    const horarios = [
      { dia: 1, abre: '09:00', cierra: '19:00' },
      { dia: 2, abre: '09:00', cierra: '19:00' },
      { dia: 3, abre: '09:00', cierra: '19:00' },
      { dia: 4, abre: '09:00', cierra: '19:00' },
      { dia: 5, abre: '09:00', cierra: '20:00' },
      { dia: 6, abre: '09:00', cierra: '17:00' },
      { dia: 0, abre: null,    cierra: null, cerrado: true },
    ];
    for (const h of horarios) {
      await pool.query(`
        INSERT INTO horarios (comercio_id, dia_semana, abre, cierra, cerrado)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (comercio_id, dia_semana) DO NOTHING
      `, [comercioId, h.dia, h.abre, h.cierra, h.cerrado || false]);
    }

    // Servicios demo
    const servicios = [
      { nombre: 'Corte clásico', precio: 500, duracion: 30 },
      { nombre: 'Corte + barba', precio: 750, duracion: 45 },
      { nombre: 'Afeitado navaja', precio: 400, duracion: 30 },
      { nombre: 'Perfilado de barba', precio: 300, duracion: 20 },
    ];
    for (const s of servicios) {
      await pool.query(`
        INSERT INTO servicios (comercio_id, nombre, precio, duracion_min)
        VALUES ($1,$2,$3,$4)
      `, [comercioId, s.nombre, s.precio, s.duracion]);
    }

    // Usuario dueño del comercio demo
    const hashDueno = await bcrypt.hash('Dueno1234!', 12);
    await pool.query(`
      INSERT INTO usuarios (email, password_hash, nombre, rol, comercio_id)
      VALUES ('dueno@mcbarber.com', $1, 'Dueño MC Barber', 'comercio', $2)
      ON CONFLICT (email) DO NOTHING
    `, [hashDueno, comercioId]);

    console.log('✅ Seed completado');
    console.log('   Superadmin:', process.env.ADMIN_EMAIL || 'admin@agendate.com', '/ Admin1234!');
    console.log('   Demo comercio: /mc-barber-studio');
    console.log('   Demo dueño: dueno@mcbarber.com / Dueno1234!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en seed:', err.message);
    process.exit(1);
  }
}

seed();
