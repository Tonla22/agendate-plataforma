const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const adminRoute = fs.readFileSync(path.join(root, 'backend', 'routes', 'admin.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'backend', 'db', 'init.js'), 'utf8');

assert.match(adminRoute, /router\.get\('\/sistema', authAdmin/);
assert.match(adminRoute, /FROM eventos_sistema/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS eventos_sistema/);
assert.match(frontend, /id="an-sistema"/);
assert.match(frontend, /id="admin-sistema"/);
assert.match(frontend, /async function cargarAdminSistema\(\)/);
assert.match(frontend, /api\('GET', '\/admin\/sistema'\)/);

console.log('admin-system-status.test ok');
