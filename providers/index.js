'use strict';
// Capa de proveedores de ejecución intercambiables.
// Interfaz: { name, capabilities, launch(task, env) → {steps, urls}, cancel(task, env) → {cooperative, note} }
const { E } = require('../lib/errors');

const manual = {
  name: 'manual',
  capabilities: { startSession: false, stopSession: false, querySession: false, cooperativeCancel: true, resumeFromCheckpoint: true },

  // "Ejecutar" en modo asistido = dejar todo listo y guiar al usuario. NO inicia nada en Colab.
  async launch(task, { channel, notebookPath }) {
    const steps = [];
    let url = null;
    if (channel) {
      steps.push('Ejecute: colabctl sync        (sube el notebook al canal configurado)');
      try { url = await channel.colabUrl(task); } catch { url = null; }
    }
    if (url) steps.push(`Abra en el navegador (en Android suele hacer falta "Sitio de escritorio"): ${url}`);
    else if (channel) steps.push('Abra Google Drive → carpeta del canal → notebooks → abra el .ipynb con "Google Colaboratory".');
    else steps.push(`Sin canal configurado: copie manualmente ${notebookPath} a Drive/GitHub, o súbalo en colab.research.google.com → Subir.`);
    steps.push('En Colab: Entorno de ejecución → Ejecutar todo (autorice Drive cuando lo pida).');
    steps.push('Después: colabctl sync  y  colabctl status   (el estado pasa a "activo" cuando llega el primer latido).');
    return { mode: 'assisted', steps, urls: url ? [url] : [] };
  },

  async cancel() {
    return { cooperative: true, note: 'Colab no puede detenerse desde aquí: se escribirá un indicador de cancelación que el notebook revisa en cada paso (requiere "colabctl sync"). Si no responde, detenga el entorno en Colab (Entorno de ejecución → Desconectar y eliminar).' };
  },
};

const unsupported = (name, reason) => ({
  name,
  capabilities: { startSession: false, stopSession: false, querySession: false },
  async launch() { throw E.unsupported(`El proveedor "${name}" no está implementado: ${reason}`, 'Use provider "manual" (flujo asistido).'); },
  async cancel() { throw E.unsupported(`El proveedor "${name}" no está implementado: ${reason}`); },
});

const REGISTRY = {
  manual,
  'colab-api': unsupported('colab-api', 'no se encontró una API pública oficial para iniciar/detener sesiones del Colab gratuito.'),
  'colab-enterprise': unsupported('colab-enterprise', 'la API de runtimes de Colab Enterprise requiere un proyecto de Google Cloud con facturación; está fuera del alcance gratuito de esta versión.'),
};

function getProvider(name) {
  const p = REGISTRY[name];
  if (!p) throw E.config(`Proveedor desconocido: ${name}`, `Disponibles: ${Object.keys(REGISTRY).join(', ')}`);
  return p;
}

module.exports = { getProvider, REGISTRY };
