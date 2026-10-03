# Cronograma, estimaciones y dependencias

**Día D1 = firma del contrato (pendiente).** P = trabajo precontractual. Días hábiles: lunes a viernes; sábado medio día opcional; domingo libre. Cada viaje a Cobán cuesta ~2 días.

## Estimación de esfuerzo (días-desarrollador, calidad de producción)

| Paquete | dd |
| --- | --- |
| Levantamiento, línea base, talleres (viaje 1) | 6 |
| Fundación: monorepo, CI, autenticación, RBAC/proyectos, bitácora, numeración, adjuntos, aprobaciones, i18n | 10 |
| M1 Contabilidad, periodos, multimoneda, BANGUAT, presupuestos, estados, libros SAT | 14 |
| M2 Proveedores, requisiciones, OC, aprobaciones, facturas/FEL, CxP, pagos, anticipos, caja chica | 10 |
| M3 Activos y depreciación | 5 |
| M4 Inventario multibodega, Kardex, conteos | 7 |
| M5 Donantes/CRM, convenios, promesas, CxC, recibos | 6 |
| M6 Cuentas bancarias, importación, conciliación | 7 |
| M8 Expedientes, distribución, motor de planilla, prestaciones, archivo IGSS, boletas | 12 |
| Migración: herramientas, ensayos, conciliación | 6 |
| Hosting, despliegue, respaldos, simulacro de restauración, monitoreo | 4 |
| Pruebas de sistema, soporte UAT, corrección | 8 |
| Manuales, capacitación (viaje 2), traspaso | 6 |
| **Total** | **~101** |

**Capacidad en 50 días calendario:** ~36 días hábiles (~43 con sábados). **Brecha: 2,3–2,8×.** La meta de 50 días con un solo desarrollador **no es creíble** para el alcance completo con calidad de producción. Esto no se resuelve reduciendo el alcance en silencio.

### Opciones para Cénit (DEC-CAP)

- **A. Más capacidad.** 1–2 desarrolladores adicionales desde ~D6, más un contador o especialista de planilla pagado como revisor. Con 3 personas es viable dentro de 59–60 días.
- **B. Aceptación por fases, aprobada por CONI en el contrato.** Fase 1 (≤ D60): M7, M1, M2, M6 y migración. Fase 2 (~D100): M3, M4, M5, M8. Requiere enmienda firmada; sin ella aplica la penalización del 5 %/día.
- **C. Plazo contractual mayor** acordado antes de la firma (p. ej. 120 días).

## Plan por ventanas

| Días | Enfoque | Requisitos | Evidencia | Insumo externo |
| --- | --- | --- | --- | --- |
| P | Documentación, línea base, monorepo, CI, núcleo del mayor y bitácora con pruebas | FND, M07-AUD, M01-ACC-003 | CI verde; pruebas de invariantes | — |
| D1–5 | Viaje 1: talleres, inventario de datos, política de aprobación, catálogo, roles. Spikes BANGUAT, FEL e IGSS | Línea base | Línea base firmada | CONI, contador |
| D6–12 | Autenticación, RBAC, RLS por proyecto, aprobaciones. Corte vertical: partida → aprobación → contabilización → balance de comprobación | M07, M01-ACC | Pruebas de aislamiento e inmutabilidad | Matriz de roles |
| D13–22 | M1 a profundidad; M2 de compra a pago y CxP; M6 importación y conciliación | M01, M02, M06 | Fronteras, duplicados, concurrencia de presupuesto | Catálogo, estados bancarios, política |
| D23–31 | M3, M4, M5 con partidas y reportes | M03, M04, M05 | Depreciación vs. hoja del contador; Kardex; desembolso parcial conciliado | Política de depreciación; decisión de lotes |
| D32–38 | M8; archivo IGSS; ensayo de migración 1 | M08, MIG | Planilla vs. cálculo independiente firmado; totales de control | Muestras de planilla, especificación IGSS, datos fuente |
| D39–44 | Pruebas de sistema, conciliación, UAT en staging, correcciones | Todos | Bitácora UAT | Usuarios de prueba de CONI |
| D45–50 | Ensayo 2 y corte, viaje 2 (capacitación), producción, simulacro de restauración, traspaso | §8 b–e | Acta de recepción, asistencia, registro de restauración | Firma de CONI |
| D51–59/60 | Holgura contractual y estabilización | — | — | — |

**Ruta crítica externa:** reglas de planilla y su aprobación, especificación IGSS, certificador FEL de CONI, saldos iniciales y datos fuente. Todo se solicita en D1. Cualquiera de estos bloquea la aceptación aunque el código esté terminado.
