# Referencia de la CLI

Cada comando, cada bandera y cada forma de salida. El [README](README.md) tiene
la versión corta; esta es la página que se abre cuando hace falta una respuesta
concreta.

La CLI se invoca por el script npm `scraper`, y **todo lo que va después de
`--` se le pasa a ella**. Ese separador no es opcional: sin él, npm lee `--json`
como configuración suya y tus banderas nunca llegan al scraper.

```bash
npm run scraper -- <comando> [opciones]
```

## `search` — consulta el formulario del portal

Fiel al sitio: mismos campos, misma validación, mismo tope de 30 filas. Un
número de expediente (o cualquier otro valor) va siempre por una bandera —
`search` no acepta argumentos posicionales sueltos, así que
`scraper search 0013201-41.2025.4.05.8202` se rechaza de plano en vez de correr
en silencio una búsqueda sin filtros:

```bash
npm run scraper -- search --number 0013201-41.2025.4.05.8202
```

**`search` imprime JSON por defecto.** Una fila de resultados trae mucho más
que sus identificadores —la clase, el asunto, las partes y el último movimiento
llegan en la misma respuesta, sin peticiones extra— y la forma de una línea solo
puede enseñar tres de esos campos:

```json
{
  "idProcessoTrf": 129921,
  "number": "0000148-15.2005.4.05.8001",
  "ca": "b63e4bf04048ad3eb054e47b3a34fad8f3d19a12e7c30f6e",
  "className": "APELAÇÃO CÍVEL",
  "subject": "Penhora / Depósito/ Avaliação",
  "parties": "FAZENDA NACIONAL X CCPAL CENTRAL DE COMPRAS DOS PANIF DE ARAPIRACA LTDA e outros (1)",
  "lastMovement": {
    "description": "Conclusos para julgamento",
    "timestamp": "28/08/2026 15:04:16"
  }
}
```

Añade `--text` para la forma corta, cuando quien lee es una persona y no una
tubería:

```bash
npm run scraper -- search --number 0013201-41.2025.4.05.8202 --text
```

```
0013201-41.2025.4.05.8202  id=129921  ca=76b81711e2c69f608d188fb631214485f3d19a12e7c30f6e

1 results
```

Buscar por rango de fecha de autuación en vez de por número exacto:

```bash
npm run scraper -- search --from 01/08/2026 --to 07/08/2026
```

Si una consulta encuentra más de 30 expedientes, el servidor recorta el
resultado y `search` avisa explicando por qué (ver [HALLAZGOS.md](HALLAZGOS.md)):

```
WARNING: 30 results — the server cap was reached, so there are more.
         The portal has no pagination. --partition is not implemented
         in this phase; use `crawl` for complete coverage.
```

Mientras trabaja, `search` nombra los filtros que envía y los dos pasos que da,
por stderr (`--quiet` lo silencia; ver *Salida de progreso*):

```
Searching the portal: number=0013201-41.2025.4.05.8202
starting a session
submitting the search form
```

`--dry-run` también sirve aquí: imprime los filtros que `search` enviaría y no
hace ninguna petición — como plan JSON por defecto, o como frase con `--text`.

## `crawl` — enumera todos los expedientes por id interno

Esta es la herramienta de cobertura completa, porque `search` nunca puede ver
más allá de 30 filas. `crawl` recorre `idProcessoTrf` —el contador interno
autoincremental del portal, sin relación con el número público— de forma
secuencial, baja el PDF resumen de cada expediente, lo parsea y lo inserta o
actualiza en SQLite.

```bash
npm run scraper -- crawl --from-id 130100 --to-id 130105 --rate 1
```

```
Stored:  3
Absent:  0   (secret or unassigned ids — expected)
Failed:  0   (recorded in the failures table for retry)
Last id: 130102
```

Mientras corre, `crawl` y `daily` imprimen una línea de progreso periódica por
**stderr** (nunca por stdout — ver *Salida de progreso*): una cabecera diciendo
qué va a hacer, y luego, cada dos segundos de reloj aproximadamente, una línea
que nombra el id en vuelo, el expediente que resultó ser y las cuentas
acumuladas:

```
Crawling 31 ids (130100-130130), 4 at a time at 2 req/s -> db /tmp/i3.db, files /tmp/i3
… 8 ids checked (at id 130107, 0010020-83.2026.4.05.8400)  stored=8 absent=0 failed=0
… 17 ids checked (at id 130116)  stored=17 absent=0 failed=0
```

Lo que acota el silencio es un intervalo de tiempo fijo, no un número fijo de
ids: el rendimiento oscila mucho según `--concurrency` y según cuánto responda
429 el portal, así que contar ids no garantiza que la terminal se quede callada
solo un rato acotado, y un intervalo de reloj sí. **Un id que falla no espera a
ese intervalo**: se reporta en el momento, con su motivo, en vez de aparecer
solo como un número en el `Failed:` final:

```
! id 130118 failed: Transient HTTP 404 from https://pjett.trf5.jus.br/…/reportPDF.seam?idProcessoTrf=130118
```

`--verbose` cambia la línea periódica por una línea por id.

Omite `--from-id` para reanudar automáticamente desde el id más alto ya
guardado (`MAX(id_processo_trf)` — ver *Cómo funciona la reanudación*). Omite
`--to-id` para correr hasta 50 ausencias seguidas, que es la heurística del
recorrido para «pasado el final del rango asignado». Previsualiza una ejecución
sin tocar la red, la base ni el disco con `--dry-run`:

```bash
npm run scraper -- crawl --from-id 130100 --to-id 130105 --dry-run
```

```
Would crawl from 130100 to 130105
```

**Código de salida:** `crawl` y `daily` salen con `0` cuando la ejecución no
registró fallos y con `1` cuando registró al menos uno. Se juzga solo la
ejecución actual, no las filas sin resolver que quedaron de una anterior — así
un `daily` en cron que falla en todos los ids se distingue de uno limpio por su
código de salida, no solo por una línea de registro que nadie mira. `search` y
las ejecuciones con `--dry-run` no se ven afectadas: salen con `0` si todo fue
bien y con `2` ante un argumento rechazado.

## `deep` — un expediente y todos los documentos de su ficha

Donde `crawl` se detiene en el PDF resumen, `deep` sigue la cadena entera hasta
los documentos que componen la ficha:

```
idProcessoTrf --(reportPDF)--> summary PDF --(parse)--> case number
              --(search by number)--> ca
              --(detail page by ca)--> document list
              --(download each)--> the documents
```

El puente por la búsqueda existe porque la ficha solo acepta `ca`, un token que
entrega la página de resultados y nadie más: la ficha rechaza el id interno de
plano, y el `ca` no se puede derivar, solo cosechar. `deep` acepta un objetivo
único o un rango explícito de ids — exactamente uno de los dos, nunca ambos y
nunca ninguno:

```bash
npm run scraper -- deep 0013201-41.2025.4.05.8202     # by case number
npm run scraper -- deep 130100                        # by internal id
npm run scraper -- deep --from-id 130100 --to-id 130120
```

Un argumento de solo dígitos se toma como el `idProcessoTrf` interno; cualquier
otra cosa se toma como número de expediente y se resuelve por el puente de la
búsqueda. Para un objetivo único:

```
Case 0801438-34.2016.4.05.8102 (id 130100):
  Documents stored:  10
  Documents skipped: 0   (already downloaded)
  Documents failed:  0   (recorded in the failures table for retry)
```

Para un rango, el resumen agrega todos los expedientes:

```
Cases done:        20
Cases failed:       0   (recorded in the failures table for retry)
Documents stored:   142
Documents skipped:  0   (already downloaded)
Documents failed:   1   (recorded in the failures table for retry)
```

**Coste:** unas **11 peticiones por expediente** — 1 PDF resumen + 1 búsqueda
(que se salta cuando ya hay un `ca` válido guardado) + 1 ficha + unos 9
documentos. Un documento que falla no aborta el expediente, y un expediente que
falla no aborta el rango: los dos se registran en `failures` y la ejecución
sigue. `--dry-run` imprime el plan sin tocar red, base ni disco, igual que
`crawl`.

Mientras corre, `deep` narra la cadena por **stderr**, nombrando cada paso
cuando *empieza* — todos tardan segundos, y un expediente que solo hablaba al
terminar eran varios segundos de silencio seguidos. Cada línea lleva la etiqueta
del expediente al que pertenece, así que una `--concurrency` mayor que 1 (por
defecto son 4) sigue siendo atribuible. Las líneas de abajo son una ejecución
real, entrelazadas tal como las produjeron los cuatro expedientes:

```
Scraping 4 cases (ids 130107-130110), 4 at a time -> db /tmp/i1.db, files /tmp/i1
[1/4 id 130107] fetching the summary PDF
[2/4 id 130108] fetching the summary PDF
[3/4 id 130109] fetching the summary PDF
[4/4 id 130110] fetching the summary PDF
[4/4 id 130110] ! summary PDF came back HTTP 404 - retry 1 of 4
[1/4 id 130107] ! summary PDF came back HTTP 404 - retry 1 of 4
[2/4 id 130108] got 0017596-39.2026.4.05.8300 (REMESSA NECESSÁRIA CÍVEL)
[2/4 id 130108] resolving the detail key: searching by case number
[2/4 id 130108] reading the case file
[2/4 id 130108] the case file lists 4 documents
[2/4 id 130108] downloading documents: 4 of 4
[2/4 id 130108] done: 0017596-39.2026.4.05.8300 - 4 documents (4 new)
```

Los reintentos de ahí son el punto, no ruido: el endpoint del PDF resumen
devuelve 404 de forma intermitente y reintenta hasta tres veces más, y el puente
por la búsqueda falla aproximadamente una de cada cuatro ejecuciones y se
rehace con una sesión nueva (ver [HALLAZGOS.md](HALLAZGOS.md)). Los dos eran
antes silencio puro en mitad de un paso que decía estar haciendo otra cosa. Un
expediente que falla se reporta igualmente en su sitio, con su motivo, y no solo
en el resumen final:

```
[3/4 id 130109] FAILED: No summary PDF for id 130109 (unassigned or sealed).
```

Un expediente cuyos documentos ya están descargados lo dice por adelantado
(`downloading documents: 4 already on disk, nothing to fetch`) en vez de después
del hecho. Ver *Salida de progreso* para `--verbose`, `--quiet` y el reparto
entre stdout y stderr.

**Los documentos vienen en dos formas.** Los binarios (PDF) son enlaces de
descarga corrientes y funcionan en frío, sin sesión; cada uno se escribe en
`<año>/<número>/documents/<fecha>-<tipo>-<id>.pdf`, junto al PDF resumen del
propio expediente. Los documentos HTML (el texto de un acto judicial, renderizado
en línea en vez de como archivo) llevan un *segundo* `ca`, atado a la sesión, que
solo
resuelve con el mismo tarro de cookies que trajo la ficha; su contenido se
guarda directamente en la tabla `documents` (`text_content`) en vez de como
archivo aparte, porque no hay blob que valga la pena escribir. Un expediente
reciente puede tener legítimamente cero documentos binarios (verificado en vivo:
uno de 2026 tenía 2 documentos HTML y ninguno binario), así que ese desenlace no
se trata como error. Un documento ya descargado en una ejecución anterior se
salta sin petición, que es lo que hace barato volver a correr `deep` sobre el
mismo objetivo o rango.

**Movimentações ≠ documentos.** La línea temporal de movimientos de un
expediente enlaza a actos por el mismo endpoint que usa un documento HTML, pero
nunca lleva el parámetro `idProcessoDoc` de ese endpoint — verificado en vivo, un
enlace de esa línea solo vuelve a traer un acto ya listado como documento real en
la misma página, o una página sin acto ninguno. Esos enlaces no son documentos y
nunca se guardan como tales: solo un disparador que lleve un `idProcessoDoc` real
se convierte en una fila de `documents`.

**El `ca` es una caché, no un hecho.** Es estable dentro de una ventana de
tiempo pero caduca a las pocas horas (verificado en vivo: un `ca` capturado 14
horas antes ya no funcionaba). `deep` reutiliza el `ca` que tenga guardado para
un expediente y solo recurre al puente de la búsqueda —volviendo a derivarlo y
actualizando el valor— cuando la propia ficha informa de que el guardado está
rancio. No hay marca de caducidad que llevar aparte: la respuesta de la ficha es
la comprobación, y esa no puede quedarse obsoleta como sí podría una marca de
tiempo en caché.

## `case` — captura exactamente un expediente

`case` es `deep` con un solo objetivo, y rechaza un rango. Existe para que la
petición más común —*tráeme este expediente, con todo lo de su ficha*— no se
pueda convertir por una errata en un recorrido de mil:

```bash
npm run scraper -- case 0013201-41.2025.4.05.8202
npm run scraper -- case 130100          # a bare number is an internal id
```

Un expediente cuesta unas 11 peticiones: el PDF resumen, una búsqueda (que se
salta si ya hay un `ca` válido guardado), la ficha y una por documento.

## `find` — búsqueda de texto completo sobre lo capturado

`find` no toca el portal. Consulta el índice FTS5 local sobre números y
metadatos de expediente, nombres de partes, descripciones de movimientos y el
texto íntegro de los documentos capturados. Los acentos son opcionales:
`execucao` encuentra `execução`:

```bash
npm run scraper -- find "honorários advocatícios"
npm run scraper -- find "UNIAO FEDERAL" --limit 50 --json
```

Los resultados se ordenan con BM25 y llevan un fragmento que enseña dónde
coincidió, así que un acierto en el texto de una sentencia se distingue de uno en
el nombre de una parte.

## `daily` — avanza la marca de agua

Un `crawl` sin rango explícito: siempre reanuda desde la marca guardada y
avanza desde ahí, que es lo natural para una ejecución programada. Rechaza
`--from-id` y `--to-id` de plano —usa `crawl` si necesitas un rango— para que una
ejecución en cron no pueda apuntar por accidente a otro sitio:

```bash
npm run scraper -- daily
```

Sobre una base recién creada —sin expedientes, así que la marca es `0`— `daily`
empieza en el id `1`. Según cómo estén asignados los ids bajos, eso o se detiene
enseguida tras 50 ausencias seguidas, o —si resulta que los ids bajos son
expedientes reales— arranca un recorrido completo del corpus de unos 133.000,
que al rendimiento medido lleva muchas horas. `daily` está pensado para una base
que ya tiene una marca razonablemente al día; sobre una vacía de verdad, conviene
correr antes `crawl` con un `--to-id` o un `--limit` explícito si no se quiere un
paseo entero desde el id 1.

## Cómo funciona la reanudación

`crawl` y `daily` no necesitan sesión ni archivo de checkpoint para reanudar: el
endpoint del PDF resumen no tiene estado (ver [HALLAZGOS.md](HALLAZGOS.md)), y la
marca de agua es sencillamente el `MAX(id_processo_trf)` que ya hay en `cases`.
Reanudar tras una interrupción —una caída, un Ctrl-C, una ejecución programada
que sigue donde acabó la de ayer— es volver a lanzar el comando, sin contabilidad
extra. Los ids que fallaron de forma no permanente quedan en `failures`;
reintentarlos significa volver a correr `crawl` con un rango explícito que los
cubra, porque una reejecución por defecto reanuda desde la marca y esa solo
avanza pasados los ids *guardados*, así que no vuelve sola a uno más bajo. En
cuanto un id que había fallado se guarda bien, su fila de `failures` queda
resuelta.

Los ids confirmados como ausentes se registran en `probes`, pero solo para que
se vean: `crawl` nunca consulta esa tabla para saltarse un id, así que una
reejecución sobre el mismo rango vuelve a sondear cada ausencia anterior en vez
de darla por definitiva. Es intencionado, no un descuido: a diferencia de un
expediente guardado, «ausente» no es un hecho estable sobre un id. Un expediente
puede pasar a secreto de justicia después de haber sido público, o uno bajo
secreto puede hacerse público más tarde, así que dar por zanjada una ausencia
antigua significaría no enterarse nunca de ninguna de las dos transiciones.

## Salida de progreso

Todo comando que toca la red imprime su progreso por **stderr** y su resultado
por **stdout** — así `--json`, y cualquier otra tubería sobre la salida final,
queda siempre limpio por mucho progreso que imprima la ejecución al lado. Cuánto
progreso hay es uno de tres niveles:


| Nivel   | Bandera     | Qué acaba en stderr                                                                                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Callado | `--quiet`   | Nada. El resultado sigue yendo a stdout, como siempre.                                                                                             |
| Normal  | *(ninguna)* | Una cabecera diciendo qué va a hacer la ejecución, luego cada paso **cuando empieza**, más cada fallo y every retry **as it happens**. |
| Detallado | `--verbose` | Todo lo anterior, más cada documento y las peticiones HTTP, respuestas y reintentos bajo la narracion.                           |


`--quiet` y `--verbose` son opuestas, así que pasar las dos se rechaza (código
de salida 2) en vez de dejar que una gane en silencio.

**Steps are announced when they start, not when they finish.** Fetching a
summary PDF, resolving a detail key through the search bridge, reading a
case file and downloading its documents each take seconds; a line printed
only on completion means the terminal is silent for exactly as long as the
thing you would want to know about is happening. The same rule is what puts
retries on screen: both retrying paths in this scraper (the summary PDF's
intermittent 404s and the search bridge's `ActionNotExecutedError`, see
*Findings*) used to be silence in the middle of a step that had already
claimed to be doing something else.

`**--verbose**` adds the requests. A single case, start to finish, on a run
where the summary PDF needed one retry:

```
Scraping 1 case (id 130109) -> db /tmp/i2.db, files /tmp/i2
[1/1 id 130109] fetching the summary PDF
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/reportPDF.seam?idProcessoTrf=130109
  ← 404  16.8 kB in 2472 ms
[1/1 id 130109] ! summary PDF came back HTTP 404 - retry 1 of 4
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/reportPDF.seam?idProcessoTrf=130109
  ← 200  19.6 kB in 788 ms
[1/1 id 130109] got 0019122-32.2026.4.05.8400 (REMESSA NECESSÁRIA CÍVEL)
[1/1 id 130109] resolving the detail key: searching by case number
  → GET https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam
  ← 200  47.0 kB in 583 ms
  → POST https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam;jsessionid=…
  ← 200  5.8 kB in 559 ms
[1/1 id 130109] reading the case file
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/listView.seam?ca=44792153139a99aa…
  ← 200  90.7 kB in 1503 ms
[1/1 id 130109] the case file lists 4 documents
[1/1 id 130109] downloading documents: 4 of 4
  → GET https://pjett.trf5.jus.br/pjeconsulta/…/documentoSemLoginHTML.seam?ca=9d14ecaf…&idProcessoDoc=12425121
  ← 200  54.6 kB in 751 ms
[1/1 id 130109]   + document id=12425121 (html) stored
…
[1/1 id 130109] done: 0019122-32.2026.4.05.8400 - 4 documents (4 new)
```

Un 429 o un 5xx también aparecen aquí, antes de la espera y no después, para
que una ejecución que va a quedarse callada un minuto ya haya dicho por qué:

```
  ↻ rate limited (HTTP 429) - waiting 2.0s before attempt 2 of 5
```

En `crawl` y `daily`, `--verbose` cambia el latido periódico por una línea por
id, que nombra el expediente en que resultó cada id guardado y el motivo por el
que falló cada uno que falló:

```
+ id=130100  stored 0013475-36.2026.4.05.0000  (stored=1 absent=0 failed=0)
. id=130101  absent  (stored=1 absent=1 failed=0)
! id=130102  failed: Transient HTTP 404 from https://pjett.trf5.jus.br/…  (stored=1 absent=1 failed=1)
```

`**--quiet**` prints nothing at all to stderr — the case for it is a
scheduled run whose stderr nobody reads until the exit code says to:

```bash
npm run scraper -- deep --from-id 130107 --to-id 130108 --quiet --db /tmp/i5.db --out /tmp/i5
```

```
Cases done:        2
Cases failed:       0   (recorded in the failures table for retry)
Documents stored:   8
Documents skipped:  0   (already downloaded)
Documents failed:   0   (recorded in the failures table for retry)
```

(Node's own `ExperimentalWarning` about type stripping still appears on
stderr under `--quiet`: that comes from the runtime, not from this scraper.
`node --disable-warning=ExperimentalWarning` silences it.)

## Salida legible por máquina (`--json`)

`--json` cambia el resultado legible por una sola pieza de JSON en stdout, y
stdout no lleva nada más: las líneas de progreso van por stderr en cualquier
caso, y la pista de «vuelve a ejecutar para reintentar» se suprime del todo.
Canalizar esa salida no necesita ninguna bandera extra, con una salvedad que es
de npm y no del scraper: `npm run` imprime su propio banner de dos líneas en
stdout, así que canaliza desde `npm run --silent scraper -- ...` o desde
`node --experimental-strip-types packages/scraper/src/cli.ts ...`, que es
exactamente lo que corre el script de npm. La forma sigue al comando:

`search` — las filas que devolvió el portal y si se alcanzó su tope de 30:

```json
{
  "rows": [
    {
      "idProcessoTrf": 129921,
      "number": "0013201-41.2025.4.05.8202",
      "ca": "76b81711e2c69f608d188fb631214485f3d19a12e7c30f6e"
    }
  ],
  "capped": false
}
```

`crawl` y `daily` — los mismos contadores que imprime el resumen, más el último
id examinado (la nueva marca de agua):

```json
{ "stored": 3, "absent": 0, "failed": 0, "lastId": 130105 }
```

`deep <número|id>` — el desenlace de un expediente. Uno que falló también se
reporta como datos, no como un documento vacío:
`{ "kind": "failed", "ref": "130101", "error": "..." }`, donde `ref` es el
objetivo tal como se dio.

```json
{
  "kind": "done",
  "idProcessoTrf": 130101,
  "number": "0000786-77.2026.4.05.8400",
  "documentsStored": 0,
  "documentsSkipped": 4,
  "documentsFailed": 0
}
```

`deep --from-id/--to-id` — las mismas cuentas agregadas sobre todo el rango:

```json
{
  "casesDone": 3,
  "casesFailed": 0,
  "documentsStored": 9,
  "documentsSkipped": 0,
  "documentsFailed": 0
}
```

`--dry-run` — el plan, como datos en vez de como la frase que imprime el modo
por defecto. `dryRun` y `command` lo identifican; un límite que el comando
habría rellenado por su cuenta viene como `null` y no como clave ausente, así que
«reanudar desde la marca» se distingue de «empezar en el id 1» sin tener que
sondear si falta una clave:

```bash
npm run scraper -- daily --dry-run --json
```

```json
{ "dryRun": true, "command": "daily", "fromId": null, "toId": null }
```

El plan de `search` lleva `filters` en su lugar, y el de `deep` lleva `target`
—el objetivo único, o `null` para un rango— junto a `fromId` y `toId`.

## Banderas

**Filtros de búsqueda** (reflejan el formulario del sitio; los usa `search`):


| Bandera               | Significado                                          |
| --------------------- | ---------------------------------------------------- |
| `--number <n>`        | Número CNJ exacto                                    |
| `--from <dd/mm/aaaa>` | Fecha de autuación, inicio del rango                 |
| `--to <dd/mm/aaaa>`   | Fecha de autuación, fin del rango                    |
| `--class <nombre>`    | Clase judicial (parcial, sin distinguir acentos)     |
| `--party <nombre>`    | Nombre de parte — el servidor exige dos palabras     |
| `--lawyer <nombre>`   | Nombre de abogado — mismas dos palabras              |
| `--document <n>`      | CPF o CNPJ                                           |
| `--document-type <t>` | `cpf` o `cnpj` (por defecto: `cpf`)                  |
| `--oab <n>`           | Número de inscripción OAB                            |
| `--oab-state <uf>`    | Estado de la OAB — no hace nada sin `--oab`          |
| `--reference <n>`     | Número del proceso de referencia                     |
| `--partition`         | **Sin implementar** — el portal no pagina; usa `crawl` |


**Rango del recorrido** (lo usa `crawl`; es un contador interno, no una fecha —
no confundir con `--from` y `--to` de arriba):


| Bandera         | Significado                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `--from-id <n>` | Primer `idProcessoTrf` a probar (por defecto: reanuda desde la base)    |
| `--to-id <n>`   | Último `idProcessoTrf` a probar (por defecto: para tras 50 ausencias)   |
| `--limit <n>`   | Para tras examinar `n` ids                                              |


`--from` y `--to` son **fechas de autuación**, las que entiende el formulario
del portal, y solo aplican a `search`. `--from-id` y `--to-id` son el **contador
interno `idProcessoTrf`** que recorre `crawl`, sin relación con ninguna fecha, y
no tienen efecto sobre `search`. `daily` no acepta ninguno de los dos: siempre
reanuda desde la marca guardada.

**Generales** (aplican a todo comando que toca la red o el disco):


| Bandera               | Significado                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--concurrency <n>` | Peticiones en paralelo durante `crawl` y `daily` (por defecto: 4)                                                                                               |
| `--rate <n>`        | Peticiones por segundo (por defecto: 2)                                                                                                                    |
| `--db <path>`       | Archivo SQLite (por defecto: `data/pje.db`)                                                                                                                |
| `--out <path>`      | Directorio de PDF (por defecto: `data/pdfs`)                                                                                                                |
| `--json`            | Salida legible por máquina en stdout, incluido el plan de `--dry-run` (el progreso, si lo hay, sigue en stderr — *Machine-readable output*)                |
| `--verbose`         | Añade las peticiones bajo la narración: URL, códigos de estado, reintentos, backoff de 429, y una línea por documento and per crawled id (see *Progress output*) |
| `--quiet`           | Imprime solo el resultado final — nada en stderr (ver *Salida de progreso*)                                                                      |
| `--dry-run`         | Planifica el trabajo sin tocar la red, la base ni el disco (imprime el plan como JSON con `--json`)                                          |


**De primer nivel** (van solas, en lugar de un comando):


| Bandera              | Significado                          |
| ------------------ | ------------------------------------ |
| `--version` / `-v` | Imprime la versión instalada y sale |
| `--help` / `-h`    | Imprime el uso y sale                |

## Dónde acaba cada cosa

- **`data/pje.db`** — una base SQLite con:
  - **`cases`** — una fila por expediente. Junto al número, la clase, el
  órgano, la turma, la fecha de distribución y los asuntos (parseados del PDF
  resumen, tanto por `crawl` como por `deep`), hay tres columnas que solo salen
  de la ficha (`deep`, una vez la ha traído): `jurisdiction` (`TRF5` en todos
  los expedientes observados), `court_address` (la dirección postal del órgano
  que decide) y `reference_number` (un número de expediente relacionado, cuando
  la página lo cita). Una base existente gana esas columnas sola en su próxima
  apertura — ver *Migraciones de esquema*.
  - **`parties`** — una fila por participante de las tablas Polo Ativo y Polo
  Passivo de la ficha (solo `deep`): id del expediente, `polo`
  (`ativo`/`passivo`), nombre, `document_type` (`cpf`/`cnpj`) y número,
  inscripción OAB, rol procesal y situación, todo separado de la única línea de
  texto libre de la página. Las dos listas las pagina el portal con un
  `Richfaces.Datascroller`; cuando la cuenta parseada no cuadra con el total que
  declara la propia página, eso se registra como una fila de tipo `parties` en
  `failures` en vez de guardarse en silencio como si la lista estuviera completa
  — el expediente en sí sigue dándose por bueno, conservando las filas que *sí*
  se parsearon. Volver a correr un expediente reemplaza sus partes en vez de
  duplicarlas.
  - **`movements`** — una fila por entrada del historial procesal: id del
  expediente, `position` (el orden del propio historial), `timestamp` y
  `description`. Hay dos fuentes, y no valen lo mismo.
  
    `deep` lee la propia tabla «Movimentações do Processo» de la ficha, página
    a página —quince filas cada vez, a través del deslizador numérico de
    RichFaces que la pagina—. `crawl` y `daily` no tienen la ficha en la mano,
    así que sacan el historial del PDF resumen que todo expediente ya descarga,
    sin peticiones extra.
  
    La tabla es la mejor de las dos. Medido sobre el expediente
    0000292-82.2007.4.05.8400, cuya página declara 4.182 movimientos: la tabla
    devuelve exactamente eso; el PDF devuelve 4.200. Los dieciocho de más no son
    movimientos — una audiencia dice *«Audiência Instrução Realizada para
    26/05/2008 17:11:00 Sala de Audiências.»*, con una marca de tiempo dentro de
    su propio texto, y el parser del PDF delimita los movimientos por marcas de
    tiempo, así que corta ahí e inventa una segunda entrada que solo dice «Sala
    de Audiências.». Todo expediente con audiencia tiene esto. El texto del PDF
    viene además más sucio: *«Não- acolhidos»*, arrastrando el guion y el espacio
    de un salto de línea.
  
    Así que la versión del PDF nunca puede sobrescribir la de la tabla. Esa
    regla vive en `replaceMovementsForCase`, no en quien lo llama, porque es un
    invariante sobre los datos: sin ella, un `crawl` que pase por encima de un id
    ya capturado en profundidad degrada el expediente en silencio —de 21
    movimientos a 19— y `crawl` nunca carga la página que necesitaría para
    notarlo. Una fuente igual o mejor
    siempre escribe, así que un segundo recorrido sigue refrescando un
    expediente que solo tenía la versión del PDF.
  
    Paginar cuesta una petición por cada quince movimientos más allá de los
    primeros: nada en el 85% de un acervo real, 2,6 de media, y 279 en el único
    expediente con 4.182. El tamaño de página no es negociable: `rows` está fijo
    en el XHTML del propio servidor, y pedir cien devuelve quince.
  
    `deep` contrasta igualmente la cuenta guardada con el total que declara la
    página y registra una fila `movements` en `failures` si no cuadran. Volver a
    correr un expediente reemplaza sus movimientos en vez de duplicarlos.
  - **`documents`** — una fila por documento que `deep` ha descargado: para uno
  binario, su `pdf_key` en el almacén de blobs *y* su propio `text_content`
  (extraído del PDF con el mismo extractor que usa el resumen); para uno HTML,
  el contenido directamente en `text_content` y sin blob.
  - **`probes`** (ids confirmados como ausentes) y **`failures`** (errores
  reintentables o dignos de mención, incluidas las comprobaciones de
  truncamiento de partes y movimientos de arriba).
- **`data/pdfs/`** — un PDF resumen por expediente en
`<año>/<número>/summary.pdf` y, en cuanto `deep` haya corrido sobre él, sus
documentos binarios al lado, en
`<año>/<número>/documents/<fecha>-<tipo>-<id>.pdf`. Por ejemplo:
  ```
  data/pdfs/2016/0801438-34.2016.4.05.8102/
    summary.pdf
    documents/
      24-07-2025_20-30-45-Despacho-12284583.pdf
      03-06-2022_12-15-47-Despacho-12284566.pdf
      ...
  ```

  Los documentos HTML no tienen archivo aquí: su contenido vive solo en la base.

## Migraciones de esquema

Las tablas nuevas salen gratis (`CREATE TABLE IF NOT EXISTS`), pero las
*columnas* nuevas sobre una tabla existente no: SQLite no tiene
`ADD COLUMN IF NOT EXISTS`, y una base de una versión anterior del proyecto no
va a criar una sola.

`openDatabase` corre un paso de migración pequeño e idempotente en cada apertura
(`migrateSchema`, en `packages/core/src/schema.ts`): comprueba con
`PRAGMA table_info` cada columna que este proyecto haya añadido nunca a `cases`
y emite un `ALTER TABLE ... ADD COLUMN` solo para las que falten de verdad. En
una base recién creada no cambia nada —el esquema ya las creó, así que cada
comprobación las encuentra— y sobre una existente no hace falta ningún comando
de migración aparte: basta con abrirla, como ya hace cualquier comando de esta
CLI.

Las dos rutas se crean a demanda bajo el directorio de trabajo actual y se
pueden cambiar con `--db` y `--out` — incluidos todos los directorios padre, así
que no hay nada que preparar a mano ni en un clon recién hecho (`data/` está en
el `.gitignore` y no existe hasta que la primera ejecución lo crea). El
directorio de `--db` se crea al abrir la base; el árbol de `--out`, según se
escriben los PDF.

## Pruebas

```bash
npm test                    # suite sin red, determinista
PJE_LIVE=1 npm test          # añade las pruebas contra el portal real
npm run typecheck            # tsc --noEmit sobre los cuatro proyectos
npm run check:runtime        # importa packages/core con el stripping de tipos de Node,
                              #   para cazar lo que el verificador permite pero el
                              #   runtime no puede ejecutar (p. ej. sintaxis TS que
                              #   sobrevive al borrado de tipos, como parameter properties)
```

La suite sin red —todo lo que `npm test` corre por defecto— se ejecuta
íntegramente contra fixtures y no hace ninguna llamada de red, que es lo que la
hace segura en CI y segura para repetirla mientras se desarrolla. (Su número
exacto de pruebas cambia según crece; corre `npm test` para el número actual
en vez de fiarte de una cifra escrita aquí.)

`packages/scraper/tests/live.test.ts` está detrás de `PJE_LIVE=1` y golpea el
portal real del TRF5 a ritmo bajo (1 petición por segundo). Se salta por defecto
para que `npm test` siga siendo determinista y sin red; se corre explícitamente
para confirmar contra el sitio en vivo:

```bash
PJE_LIVE=1 npm test
```

Cubre tres cosas:

1. **Control de regresión.** Buscar el expediente conocido
 `0013201-41.2025.4.05.8202` tiene que devolver exactamente una fila con
 `idProcessoTrf === 129921`. El parámetro real de envío de la búsqueda es un id
 generado por JSF que se lee de la página en tiempo de ejecución (ver
 [HALLAZGOS.md](HALLAZGOS.md)) y puede cambiar en cualquier redespliegue del
 portal. Si el cliente dejara de recoger un valor nuevo, **todas** las búsquedas
 devolverían cero resultados en silencio y sin error; esta prueba convierte eso
 en un fallo inmediato y ruidoso.
2. **Descarga en frío.** `fetchReportPdf` contra un id conocido, sin sesión ni
 cookies previas, devuelve un PDF que parsea a un número de expediente bien
 formado — la prueba de que el endpoint no tiene estado de punta a punta.
3. **Clasificación fuera de rango.** Un id muy por encima del contador
 observado (999999999) se clasifica como `'absent'`, no como `'transient'` — en
 [HALLAZGOS.md](HALLAZGOS.md) está por qué confundir esos dos sería un error de
 verdad y no cosmético.
