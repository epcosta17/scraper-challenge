# Lo que el portal hace de verdad

Esta es la parte del trabajo que no se podía adivinar leyendo el enunciado: el
comportamiento de una aplicación JBoss Seam de 2009 que responde a una petición
fallida con un éxito, y las decisiones que se tomaron por eso.

Léelo si quieres saber por qué el código tiene la forma que tiene. Todo lo de
abajo se observó contra el portal real, no se dedujo.

## No hay paginación

El portal corta todo resultado en 30 filas y lo dice en su propia respuesta
(«Sua consulta retornou muitos processos e somente os 30 primeiros serão
exibidos»). El tope vive en la capa de consulta —un `setMaxResults(30)` aplicado
antes de serializar, no un límite de la vista—, así que ningún parámetro de la
petición lo vence.

Se probaron siete caminos independientes y se descartaron todos:

- No hay cabeceras de columna ordenables con las que reordenar el resultado y
  obtener otras 30 filas.
- El componente `DataScroller` de RichFaces no está en ninguna parte del
  paquete de la página.
- El contenedor `<div title="Paginação">` está vacío incluso cuando el
  resultado sale recortado.
- Ninguno de los 66 enlaces de la página lleva a una entrada alternativa: todos
  son externos, al CNJ o al propio TRF5.
- El campo de número no acepta coincidencias parciales ni comodines, solo el
  número exacto.
- Falsificar parámetros de vista de RichFaces o de página de Seam
  (`firstResult`, `maxResults`, `page`, `pageSize`) devolvió las mismas 30
  filas, byte por byte.
- Los resultados vienen ordenados por el año de autuación del número, ascendente,
  y esa clave de orden no tiene ningún filtro de rango expuesto — así que
  tampoco hay paginación por cursor: no hay cursor que avanzar.

Esa es la razón entera de que `crawl` exista como comando aparte: **enumerar
`idProcessoTrf` directamente es el único camino que alcanza el 100% del
corpus**.

## Cómo se llega a los PDF

El PDF resumen de cada expediente vive en
`DetalheProcessoConsultaPublica/reportPDF.seam?idProcessoTrf=N`, indexado por el
contador interno y no por el número público.

Y lo decisivo: ese endpoint **funciona en frío** — sin cookies, sin sesión, sin
haber visitado antes la búsqueda ni la ficha del propio expediente. Cada
petición es autocontenida, que es lo que hace a `crawl` trivialmente reanudable
(no hay sesión que restablecer tras un reinicio) y paralelizable sin riesgo (no
hay estado de sesión compartido por el que compitan varios workers).

## El éxito lo decide el cuerpo, nunca el código de estado

Tanto un id ausente (sin asignar o fuera de rango) como un expediente en
secreto de justicia devuelven **HTTP 200** con una página de error HTML
concreta y reconocible, nunca un 404.

La clasificación mira el cuerpo, en orden:

1. `%PDF-` en los primeros cinco bytes significa éxito.
2. Si no, un HTTP 200 cuyo cuerpo *sí* se parece a la página de error conocida
   significa ausente.
3. Cualquier otra cosa es **transitorio**: un estado distinto de 200 e
   intermitente (observado en vivo como un HTTP 404 esporádico desde un nodo
   enfermo detrás del balanceador), o un HTTP 200 con un cuerpo *no reconocido*
   —una página de mantenimiento, un interstitial antibot, una redirección a
   login, o cualquier cambio de forma del portal—.

Las tres no se pueden confundir jamás. `fetchReportPdf` reintenta un número
acotado de veces antes de darse por vencido como transitorio, y los dos
desenlaces de fallo se registran distinto: un id ausente va a `probes`, y un
fallo transitorio va a `failures` y se reintenta en una ejecución posterior.

La ausencia no se trata como permanente: `crawl` vuelve a sondear un id
previamente ausente en cada ejecución en vez de saltárselo, porque un
expediente bajo secreto puede hacerse público después. Tratar un fallo
transitorio como ausencia perdería en silencio y para siempre un expediente que
sí existe; tratar una ausencia como transitoria significaría reintentar
aproximadamente el 15% del recorrido entero, para nada.

## El formulario de búsqueda falla en silencio de seis formas

Y el cliente las vence todas.

**Uno.** El `onclick` del botón «Pesquisar» es código muerto: dice
`return executarReCaptcha();` — ese `return` pelado corta antes de que llegue a
ejecutarse la llamada a `A4J.AJAX.Submit(...)` que le sigue en la misma línea,
así que los parámetros embebidos en esa llamada muerta son una pista falsa. El
envío real ocurre desde otra función, `executarPesquisa()`, definida en línea en
la página, y su parámetro de envío es un id generado por JSF (`fPP:j_id244` al
momento de escribir esto) que hay que **leer de la página en tiempo de
ejecución** en vez de fijarlo, porque puede cambiar en cualquier redespliegue.

**Dos.** Los dos campos `*InputCurrentDate` —el estado interno de mes y año de
los selectores de fecha de RichFaces— tienen que llevar siempre un `MM/YYYY`
válido, incluso cuando no se está filtrando por fecha en absoluto. Si alguno
queda vacío, el componente de calendario falla al decodificar y JSF **descarta
el filtro de fecha en silencio** en vez de dar un error, lo que se lee como «la
búsqueda ignoró mis fechas» sin ningún diagnóstico.

**Tres.** Los nombres de parte y de abogado necesitan al menos dos palabras
separadas por espacio; con una sola el servidor rechaza en silencio, así que el
cliente lo detecta antes de enviar nada.

**Cuatro.** Un estado de OAB seleccionado sin número de OAB el servidor
simplemente lo ignora, de modo que el cliente rechaza esa combinación de
entrada en vez de mandar una consulta que descarta calladamente la mitad de lo
pedido.

**Cinco.** Una respuesta AJAX normal siempre trae una cabecera
`Ajax-Update-Ids` nombrando qué región de la página cambió. Cuando se ejercita
por accidente el camino del código muerto, esa cabecera vuelve como
`fPP:j_id248` —el panel de mensajes— en vez de `fPP:processosGridPanel` —la
tabla de resultados—, lo que significa que la acción de búsqueda **nunca llegó a
ejecutarse**. Eso es una situación radicalmente distinta de una consulta que
legítimamente no encontró nada, y el parser levanta `ActionNotExecutedError` en
vez de reportar cero resultados: reportar cero en silencio sería
indistinguible de un resultado vacío de verdad.

**Seis**, y fácil de pasar por alto entera: el cuerpo de la petición hay que
codificarlo en `ISO-8859-1`, que es lo que este portal declara en su
`Content-Type` — pero el `URLSearchParams` nativo de JavaScript siempre
codifica en UTF-8, digas lo que digas en la cabecera. Con ese desajuste el
servidor decodifica bytes UTF-8 como Latin-1 y devuelve resultados equivocados
y truncados, sin avisar: medido en vivo, una búsqueda de un nombre con acentos
devolvió **6 filas** con la codificación UTF-8 de `URLSearchParams` frente a las
**30 correctas** con un codificador ISO-8859-1 propio.

## Y dos codificaciones en el mismo servidor

La ficha del expediente llega en ISO-8859-1. Sus propios fragmentos AJAX llegan
en UTF-8. Ninguno de los dos lo declara.

Eso estuvo latente mucho tiempo en la búsqueda, porque de sus resultados solo se
leían el número y el token —ambos ASCII—. En cuanto se empezaron a leer la
clase, el asunto y las partes, cada acento salía roto. Cada respuesta se
decodifica ahora según lo que es, no según lo que el servidor dice.

## Manejo de 429

El cliente HTTP es el único cuello por el que pasa toda petición, así que el
límite de ritmo y la política de reintentos viven en un solo sitio
(`packages/scraper/src/http/client.ts`).

Ante un `429` retrocede exponencialmente con jitter —base 1 s, factor 2, ±25%,
hasta 5 intentos—, respetando una cabecera `Retry-After` del servidor (en
segundos o como fecha HTTP) por encima del backoff calculado cuando viene.

El retardo está **acotado a 60 s por intento** en ambos casos: el mismo tope
limita el backoff calculado y el `Retry-After` obedecido, así que un servidor
que mande `Retry-After: 86400` duerme a un worker 60 segundos, no 24 horas.

Un `429` además empuja la siguiente petición de **todos** los workers, no solo
la del que fue rechazado — si no, los otros `concurrency-1` seguirían disparando
al `--rate` completo y el ritmo agregado del recorrido nunca bajaría de verdad
bajo un límite real.

Una petición que agota todos los reintentos levanta `RateLimitedError`; dentro
de `crawl` eso aparece como una fila registrada en `failures` en vez de abortar
la ejecución, así que un id persistentemente limitado no impide que el recorrido
cubra el resto del rango. Una ejecución posterior lo reintenta.

**Dicho honestamente**: nunca se llegó a reproducir un `429` probando este
scraper, ni con 16 workers concurrentes contra `reportPDF.seam` en vivo. El
rendimiento se satura alrededor de 3 peticiones por segundo pasados unos 8
workers — el servidor absorbe la concurrencia añadida ralentizando cada
respuesta en vez de rechazar peticiones.

Así que el manejo de 429 está implementado completo porque el enunciado lo pide
y porque una ejecución larga y sostenida en producción es justo el escenario con
más probabilidades de acabar provocándolo, pero **no está verificado contra un
`429` real de este portal**.
