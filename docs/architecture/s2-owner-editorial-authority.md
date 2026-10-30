# S2 — autoridad del propietario para cambios editoriales y límites de evidencia

**Decisión adoptada:** 29 de octubre de 2026 · PR #38 · alcance: banco DEV de preguntas S2 y gobierno editorial interno.

## Autoridad y aprobación

La persona que opera este proyecto ha declarado expresamente en esta conversación que actúa como **propietario, revisor y responsable de las decisiones** y ha **aprobado las nueve decisiones de `adj_z_9_revision_s.csv`**. Esa instrucción es suficiente para la **aprobación editorial interna** de las ocho reformulaciones y para conservar la novena pregunta negativa con la restricción indicada. No se requiere conseguir una segunda autorización de revisor externo para aplicar estos **cambios en el corpus de desarrollo**.

Esta aprobación reemplaza el _bloqueo administrativo de autorización del propietario_ previamente documentado en §108. El CSV original se conserva íntegro y puede contener `replacementOwnerApproved=False` porque refleja su estado **anterior** a esta decisión. Los archivos derivados conservan SHA-256 del original y muestran `replacementOwnerApproved=True` para las ocho sustituciones, y `ownerRetentionApproved=True` para la negativa mantenida. Esta distinción evita reescribir fraudulentamente una entrega.

La autoridad es **declarada por la persona usuaria en la conversación**; no equivale a una firma criptográfica ni autentica por sí misma la identidad legal de otra institución. La aprobación editorial **sí es efectiva** para la versión de desarrollo, aunque aún no exista una firma Ed25519 externa.

## Reglas obligatorias de aplicación

1. No borrar ni reescribir los casos originales del conjunto §104 ni los envíos X/Y/Z. Conservar trazabilidad del caso anterior, nuevo identificador, pregunta revisada, revisión SOURCE y citas UTF-16 exactas.
2. Crear una **versión DEV distinta**, con 240 preguntas y 120 EN/120 ES, y dejar los cambios de ocho casos reflejados solo en esa versión. Su esquema debe ser **incompatible** con la ingestión automática del holdout independiente de §102/§103.
3. Mantener la negativa #138 con su limitación a la fuente documental examinada; no inferir por analogía la URL de una ejecución VS Code desde el ejemplo de CLI de FastAPI, ni declarar ausencias fuera del ámbito realmente revisado.
4. Separar tres decisiones: **aprobación editorial del propietario** (concedida), **derechos y ámbito SOURCE de terceros** (no acreditados por esta declaración), **independencia estadística y adjudicación de verdad** (no certificadas). No transformar una bandera de revisor externo o licencia en `true` por una autorización editorial.
5. El propietario puede ordenar nuevas **enmiendas prospectivas** a las reglas internas del proyecto. Registrar siempre fecha, motivación, cambio, efecto sobre los datos ya vistos y versión aplicable. Una enmienda no convierte retroactivamente los experimentos DEV o resultados del modelo en un holdout ciego.
6. Las métricas de S2 —suficiencia semántica, precisión de citas, falsas admisiones, seguridad ACL y p95 HTTP completo— siguen siendo requisitos de evaluación por defecto hasta que exista una modificación explícita, versionada y prospectiva de la especificación. Incluso si se cambia un umbral, los hechos observados no pueden presentarse como comprobados sin medición.

## Evidencia retenida

- Propuesta original de nueve casos SHA-256: `837dd9a8afb3cf7f96023fa1a394cfc8cc607ec9db636cff979498baca708e09`.
- Acción expresamente aprobada por el propietario: **8 × REWORD_BEFORE_FREEZE**, **1 × RETAIN_NOT_ANSWERABLE_WITH_SCOPE_LIMITATION**.
- `ownerHumanReviewConfirmed=True` en los nueve registros de origen; `externalHumanReviewConfirmed=False`, `rightsAndScopeAccredited=False`, `replacementFrozen=False` siguen fieles a lo declarado en esos archivos.
- Decisión actual: `OWNER_APPROVED_DEV_CANDIDATES_NOT_INDEPENDENT_HOLDOUT`.
- Código reproducible y controles adversariales: `scripts/s2-prepare-owner-editorial-revision.py` y `scripts/test_s2_owner_editorial_revision.py`. Los datos privados y textos SOURCE se crean **fuera de Git**.

**Políticas de motor:** no se cambió la lógica productiva de admisión ni se fusionó el PR #38. S2 permanece ABIERTA; E5 SHADOW, LAYERED/BGE OFF por defecto y S3–S5 bloqueadas. Esta disposición no impide usar y seguir mejorando el corpus DEV **ya aprobado por su propietario**.
