# Registro de riesgos, supuestos, problemas y decisiones

Estados: ABIERTO · EN GESTIÓN · RESUELTO · ACEPTADO. Responsable de decidir: **Cénit** = dueño del negocio / representante legal; **CONI** = decisor autorizado del cliente (por confirmar; destinatario de la oferta: Carlos Chen, Gerente de Administración y Finanzas); **Contador** = contador o especialista designado.

Los documentos de soporte **no se modifican**. Las discrepancias se registran para aclaración del responsable.

## Riesgos comerciales y de integridad (para el dueño del negocio)

| ID | Riesgo / discrepancia | Fuente | Impacto | Decide | Estado |
| --- | --- | --- | --- | --- | --- |
| R-01 | La fecha límite de ofertas del TDR es el viernes 2026-09-25. La oferta de Cénit es del 29-09, su solvencia del 28-09 y la de Tech Web del 27-09. No consta prórroga. | TDR §10 p.9; CEN p.1, p.11, p.12 | Validez de la oferta | Cénit | ABIERTO |
| R-02 | La carta de ADIPH (26-09-2026) atribuye a Cénit una implementación en 2025. El RTU indica constitución el 18-05-2026 e inicio de operaciones el 15-07-2026. La carta también afirma conectividad "directa" con IGSS y FEL nativo. No hay código previo disponible para este proyecto. | CEN p.2, p.3 | Credibilidad de la oferta; no sirve como evidencia de capacidad existente | Cénit | ABIERTO |
| R-03 | La actividad económica registrada en el RTU es "apoyo a instalaciones" y el objeto de la patente de empresa es construcción. El pago exige una factura FEL por servicios de software. | CEN p.3, p.8; TDR §6 | Cobro | Cénit (y su contador) | ABIERTO |
| R-04 | Penalización del 5 % del valor total por día de retraso, sin tope expreso. 20 días de retraso equivalen al 100 %. | TDR §9 b | Crítico | Cénit (negociar tope y definición de "entera satisfacción") | ABIERTO |
| R-05 | Plazos: TDR máx. 60 días (firma u OC); Cénit 59 días (firma); meta interna 50. | TDR §4; CEN p.13 | Cronograma | Contrato | ABIERTO |
| R-06 | Pago 100 % contra recepción (TDR); la tabla de Cénit no indica el momento. Sin flujo de caja durante la implementación. El arreglo de pago del desarrollador con Cénit no está establecido. | TDR §6; CEN p.13 | Financiero | Cénit | ABIERTO |
| R-07 | Hosting gratuito por 3 años con monitoreo y soporte 24/7: costo recurrente y obligación de personal de Cénit sin presupuesto ni responsable. | CEN p.13 | Operativo/financiero | Cénit | ABIERTO |
| R-08 | Capacidad: el esfuerzo estimado es de ~101 días-desarrollador frente a ~36–43 días hábiles en 50 días calendario (brecha de 2,3–2,8×). | docs/07-cronograma.md | Crítico | Cénit (opciones A/B/C) | ABIERTO |
| R-09 | Nombre de archivo requerido "Mobiliario y Equipamiento Proyecto Brigadas" y contexto de mobiliario en la introducción del TDR. | TDR §1, §7 | Bajo (copia de otro proceso) | — | ACEPTADO |
| R-10 | Trabajo en sitio en Cobán (entrega, implementación, capacitación). Mínimo dos viajes de ~2 días cada uno. | TDR §4 | Cronograma/costo | Cénit | ABIERTO |

## Diferencias entre documentos (tratamiento explícito)

| ID | Tema | Tratamiento |
| --- | --- | --- |
| D-01 | Módulo 8: "valor agregado" (p.5) frente a la matriz que exige los módulos 1–8 (p.7). | **Se planifican los 8 módulos** salvo que CONI apruebe por escrito otro alcance. |
| D-02 | Límites de aprobación: no se definen Q5,000 exacto ni Q5,000.01–Q5,000.99. | Política configurable con vigencia. Valores sembrados solo como "SIN APROBAR". Se requiere política firmada por CONI (M02-APR-002). |
| D-03 | Pago: TDR 100 % contra entrega; Tech Web 50/30/20; Cénit no lo indica. | No se importa el esquema de Tech Web. Se aplica el contrato. |
| D-04 | Montos: Cénit Q127,749.00 (con IVA y migración); Tech Web Q73,000.00 (IVA no indicado). | Ofertas distintas; no se mezclan. |
| D-05 | Hosting: Cénit 3 años sin costo; Tech Web USD 450/año opcional y por cuenta del cliente. | Solo aplica el compromiso de Cénit (CEN-005). |
| D-06 | "Webhooks SAT BANGUAT" | No corresponde a un mecanismo verificado. Ver docs/08-integraciones.md. |
| D-07 | Depreciación: TDR "tasas de la LAT **o** políticas internas"; Cénit "bajo tasas de la LAT". | Configurable por categoría. La política la aprueba el contador de CONI. |
| D-08 | Stack "sugerido" en la oferta. | ADR-001: React/TS, Node, PostgreSQL. Sin GraphQL ni Supabase. Justificado. |

## Decisiones tomadas

| ID | Fecha | Decisión | Por |
| --- | --- | --- | --- |
| DEC-001 | 2026-10-03 | Desarrollo a la medida con React/TypeScript, Node y PostgreSQL (ADR-001). | Desarrollador |
| DEC-002 | 2026-10-03 | Repositorio privado; rama `main` y ramas de funcionalidad con PR. | Desarrollador |
| DEC-003 | 2026-10-03 | Los documentos fuente no se versionan; se referencian por hash (docs/fuentes.md). | Desarrollador |
| DEC-004 | 2026-10-03 | Trabajo precontractual limitado a fundaciones reutilizables. Es inversión de Cénit en riesgo hasta la adjudicación. | Desarrollador (Cénit debe confirmar) |

## Decisiones pendientes (bloqueantes)

| ID | Decisión | Bloquea | Decide |
| --- | --- | --- | --- |
| DEC-APR | Política de aprobación exhaustiva con fronteras y vigencia | M02 | CONI |
| DEC-COA | Catálogo de cuentas | M01, migración | CONI / Contador |
| DEC-DEP | Política de depreciación por categoría | M03 | Contador |
| DEC-MIG | Fuentes, profundidad histórica, fecha de corte, saldos iniciales | Migración | CONI |
| DEC-CAP | Opción de capacidad A/B/C | Compromiso de cronograma | Cénit |
| DEC-FEL | Certificador FEL de CONI (recibos de donación) | M05-REC-001 | CONI |
| DEC-MON | Monedas adicionales a USD y su base de cotización BANGUAT (algunas se cotizan contra USD) | M01-CUR | CONI / Contador |
| DEC-RND | Aprobar redondeo de conversión (configurado HALF_UP en estado PROPUESTA) | M01-CUR | Contador |
| DEC-CIE | Política de cierre: actualmente no se permite cerrar con partidas en borrador o aprobadas; reapertura con motivo | M01-ACC | Contador |
| DEC-PRE | Política presupuestaria: bloquear o alertar el sobregiro (hoy se elige por presupuesto); gasto en cuentas sin techo (hoy disponible = 0); flujo de modificaciones de presupuestos aprobados (hoy congelados); distribución mensual; inclusión de compromisos de órdenes de compra (M02) | M01-BUD | CONI / Contador |
| DEC-VIS | Visibilidad de cuentas institucionales compartidas (ver docs/05-permisos.md) | M07, reportes | CONI |
| DEC-ROL | Matriz de roles definitiva (roles actuales en estado PROPUESTA) | M07, entregable §8 b | CONI |
