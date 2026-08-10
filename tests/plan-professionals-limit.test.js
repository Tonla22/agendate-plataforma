const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { PLANES, esCodigoPlanValido, obtenerPlan } = require('../backend/config/planes');
const init = fs.readFileSync(path.join(root, 'backend', 'db', 'init.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'backend', 'routes', 'admin.js'), 'utf8');
const comercio = fs.readFileSync(path.join(root, 'backend', 'routes', 'comercio.js'), 'utf8');
const suscripciones = fs.readFileSync(path.join(root, 'backend', 'routes', 'suscripciones.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

assert.deepStrictEqual(PLANES.inicial, {
  codigo: 'inicial',
  nombre: 'Inicial',
  monto: 1200,
  limiteProfesionales: 2
});
assert.deepStrictEqual(PLANES.comercial, {
  codigo: 'comercial',
  nombre: 'Comercial',
  monto: 1800,
  limiteProfesionales: null
});
assert.strictEqual(obtenerPlan('ESENCIAL').codigo, 'inicial');
assert.strictEqual(esCodigoPlanValido('desconocido'), false);

assert.match(init, /mercadopago_plan_inicial_id VARCHAR\(120\)/);
assert.match(init, /mercadopago_plan_comercial_id VARCHAR\(120\)/);
assert.match(init, /SET plan='comercial', suscripcion_monto=1800/);
assert.match(init, /SET plan='inicial', suscripcion_monto=1200/);
assert.match(admin, /req\.body\.suscripcion_monto = plan\.monto/);
assert.match(admin, /profesionales\.rows\[0\]\.total > plan\.limiteProfesionales/);
assert.match(comercio, /SELECT id, plan FROM comercios WHERE slug=\$1 FOR UPDATE/);
assert.match(comercio, /activos\.rows\[0\]\.total >= plan\.limiteProfesionales/);
assert.match(suscripciones, /limite_profesionales: plan\.limiteProfesionales/);
assert.match(suscripciones, /mercadopago_plan_inicial_id/);
assert.match(suscripciones, /mercadopago_plan_comercial_id/);

assert.match(frontend, /Agendate Inicial/);
assert.match(frontend, /Agendate Comercial/);
assert.match(frontend, /UYU \$1\.200/);
assert.match(frontend, /UYU \$1\.800/);
assert.match(frontend, /hasta 2 profesionales/);
assert.match(frontend, /id="btn-agregar-profesional"/);
assert.match(frontend, /window\._comLimiteProfesionales/);

console.log('plan-professionals-limit.test ok');
