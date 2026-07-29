const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/type=["']application\/ld\+json["']/i.test(match[1]))
  .filter(match => !/\bsrc=/i.test(match[1]))
  .map(match => match[2])
  .filter(source => source.trim());

assert.ok(scripts.length, 'El frontend debe contener al menos un script ejecutable.');
scripts.forEach((source, index) => {
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: `frontend-inline-${index + 1}.js` }),
    `El script inline ${index + 1} debe tener sintaxis JavaScript valida.`
  );
});

console.log('frontend-script-syntax.test ok');
