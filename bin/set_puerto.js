const fs = require('fs');

const [, , configPath, puertoArg] = process.argv;
const puerto = Number(puertoArg);

if (!configPath || !Number.isInteger(puerto)) {
  console.error('Uso: node set_puerto.js <config.json> <puerto>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.puerto = puerto;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
