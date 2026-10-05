# Especificaciones de integración

Estados: VERIFICADO (probado contra la fuente oficial) · DOCUMENTADO (fuente oficial leída, sin prueba) · SIN VERIFICAR · BLOQUEADO.

> "Webhooks SAT BANGUAT" (oferta, stack sugerido) **no describe un mecanismo verificado**. Ni BANGUAT ni la SAT empujan eventos hacia este sistema. Las integraciones reales se describen abajo.

## INT-BANGUAT: Tipo de cambio de referencia

- **Estado:** VERIFICADO para USD (2026-10-04). Llamada real desde el entorno de desarrollo: se almacenaron 36 tasas del 2026-09-01 al 2026-10-04.
- **Fuente:** servicio web SOAP público `https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx`.
- **Comportamiento observado (respuestas reales, 2026-10-04):**
  - La operación usada es `TipoCambioRangoMoneda(fechainit, fechafin, moneda)`, con fechas `dd/mm/aaaa`. **Los nombres de parámetro son `fechainit`/`fechafin`**; un resumen de la documentación decía `fecha_ini`, y es incorrecto.
  - Hay **una tasa por día calendario, incluidos fines de semana**: el sábado 26 y domingo 27 de septiembre repiten la tasa del viernes 25. Por eso no hace falta una política de "día hábil anterior" para USD.
  - USD = `moneda` 2, con hasta 5 decimales. `venta` = `compra`. El sistema rechaza la respuesta si difieren.
  - El catálogo `VariablesDisponibles` incluye monedas históricas (francos, marcos, pesetas…).
  - **Advertencia:** para `moneda` 24 se obtuvo ≈ 1.137, con compra distinta de venta. Parece una tasa cruzada contra USD, no quetzales por unidad. **Ninguna moneda distinta de USD está habilitada** para sincronización automática hasta confirmar su base de cotización con BANGUAT y con el contador de CONI (DEC-MON).
- **Implementación:**
  - `apps/api/src/integrations/banguat.ts`: analizador estricto. Valida moneda, fecha, formato de tasa y que `TotalItems` coincida con los registros.
  - `syncRates` es idempotente. Una tasa ya almacenada **no se sobrescribe**: si BANGUAT devuelve otro valor para la misma fecha, se cuenta como conflicto para revisión.
  - `rate_sync_run` registra cada ejecución.
  - Programación: `npm run rates:sync -w @coni/api` diario desde el planificador del servidor (cron o temporizador systemd). Sale con código ≠ 0 ante error o conflicto para que el monitoreo alerte.
  - Sin tasa para la fecha, la partida **no se registra** (422). Opción: tasa manual con justificación, permiso `rates.manual` y bitácora. La tasa BANGUAT prevalece sobre la manual.
  - El servidor calcula la tasa y el equivalente en GTQ. Se ignoran los valores que envíe el cliente.
  - La base de datos rechaza líneas en moneda extranjera que citen una tasa no almacenada.
- **Pruebas:** las pruebas automatizadas usan una respuesta real guardada (`apps/api/test/fixtures/`). La llamada en vivo **no** forma parte de CI.
- **Pendiente:** política de diferencial cambiario realizado y no realizado (M01-CUR-003, SUP-008). Redondeo HALF_UP en estado PROPUESTA.

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
