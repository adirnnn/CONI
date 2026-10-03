# Especificaciones de integración

Estados: VERIFICADO (probado contra la fuente oficial) · DOCUMENTADO (fuente oficial leída, sin prueba) · SIN VERIFICAR · BLOQUEADO.

> "Webhooks SAT BANGUAT" (oferta, stack sugerido) **no describe un mecanismo verificado**. Ni BANGUAT ni la SAT empujan eventos hacia este sistema. Las integraciones reales se describen abajo.

## INT-BANGUAT: Tipo de cambio de referencia

- **Estado:** DOCUMENTADO (2026-10-03). Pendiente: prueba de llamada real desde el servidor.
- **Fuente:** servicio web SOAP público `https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx` (consultado el 2026-10-03).
- **Operaciones publicadas:**
  - `TipoCambioDia`: tasa del día en dólares
  - `TipoCambioRango(fecha_ini, fecha_fin)`: dólares en un rango, `dd/mm/aaaa`
  - `TipoCambioRangoMoneda(fecha_ini, fecha_fin, moneda)`: otra moneda
  - `VariablesDisponibles`: catálogo de monedas
  - `TipoCambioFechaInicial`, `TipoCambioFechaInicialMoneda` y `Variables` también existen
- **Diseño:**
  - Tarea diaria de pg-boss que consulta `TipoCambioRango` desde la última fecha almacenada hasta hoy. Así recupera los días faltantes y es idempotente por `(moneda, fecha, fuente)`.
  - Cada tasa se guarda con su fuente (`BANGUAT`) y la fecha de consulta.
  - Si no hay tasa para la fecha, la transacción **no se contabiliza**. Opciones: usar una tasa manual con justificación, registrada en bitácora y aprobada por un rol autorizado.
  - Qué tasa aplica en fines de semana y feriados lo decide el contador (SUP-008).
- **Preguntas abiertas:**
  - Códigos de moneda distintos de USD que CONI necesita
  - Política de redondeo de la tasa
  - Disponibilidad y límites de uso del servicio

## INT-FEL: Facturas recibidas y recibos de donación

- **Estado:** SIN VERIFICAR.
- **Facturas de proveedores (M02-AP-001):**
  - Registro a partir del XML del DTE o de los datos clave: NIT del emisor, serie, número, UUID de autorización, fecha y monto.
  - Prevención de duplicados por UUID y por emisor+serie+número.
  - Por verificar en fuentes oficiales de la SAT:
    - si existe un servicio público o de certificador para validar automáticamente la autorización de un DTE
    - en su defecto, qué consulta manual o descarga de DTE recibidos está disponible
    - condiciones de uso
- **Recibos de donación (M05-REC-001):**
  - El TDR exige recibos "autorizados por la SAT". Debe verificarse qué tipo de DTE aplica a donaciones y que CONI está habilitada como emisora.
  - La emisión requiere un **certificador FEL contratado por CONI**, con sus credenciales y su ambiente de pruebas.
  - Sin eso, el sistema solo produce borradores marcados "SIN VALIDEZ FISCAL".
- **Pendiente de CONI:** certificador actual (si existe), credenciales de pruebas por un canal seguro y ejemplos de DTE recibidos.

## INT-IGSS: Planilla electrónica

- **Estado:** SIN VERIFICAR.
- No hay evidencia de conectividad "directa" (la carta de ADIPH la menciona; no es una fuente técnica).
- **Entregable:** archivo exportado en el formato oficial de la planilla electrónica del IGSS, para que CONI lo cargue en el portal del patrono.
- **Pendiente:**
  - especificación oficial del formato (versión vigente)
  - un archivo de muestra aceptado previamente por el portal
  - número patronal y centros de trabajo
- Las cuotas de IRTRA e INTECAP se calculan con tasas verificadas y aprobadas (SUP-007).

## INT-BANCOS: Estados de cuenta

- **Estado:** BLOQUEADO (sin muestras).
- Se asume importación de archivos (CSV/XLS/OFX/TXT según el banco), **sin API**.
- Un analizador por formato real.
- Prevención de importación duplicada mediante hash del archivo + rango de fechas + cuenta, y huella por línea.
- Pagos: se **registran** en el sistema. No se inician transferencias.
- **Pendiente de CONI:** bancos y cuentas (GTQ/USD) y muestras anonimizadas de estados de cuenta por banco.
