'use strict';
// Ejemplo de integración con Dekiller AI (Express). NO forma parte de las dependencias del
// proyecto: instale express en SU backend ("npm i express") y adapte las rutas.
//
//   COLABCTL_API_TOKEN="$(head -c 24 /dev/urandom | base64)" node examples/dekiller-express.js
//
// Flujo previsto:
//   1) POST /colab/v1/tasks            {name,type,config}  → crea y prepara el notebook
//   2) POST /colab/v1/tasks/:id/run                         → devuelve instrucciones (modo asistido)
//   3) GET  /colab/v1/tasks/:id                             → estado (tras "colabctl sync"/monitor)
//   4) GET  /colab/v1/tasks/:id/results[/archivo]           → resultados ya sincronizados
const path = require('path');
const express = require('express'); // eslint-disable-line import/no-unresolved
const { Manager } = require('../jobs/manager');
const { resolveHome } = require('../config');
const { createHandler } = require('../integrations/dekiller/handler');

const manager = Manager.open(resolveHome());
const app = express();
app.use('/colab', createHandler({ manager, token: process.env.COLABCTL_API_TOKEN || '', ratePerMin: manager.limits.apiRatePerMin }));
app.listen(8787, '127.0.0.1', () => console.log('Dekiller ⇄ Colab Manager en http://127.0.0.1:8787/colab/v1/status', path.basename(__filename)));
