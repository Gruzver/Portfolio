# Servidor del mapa (tu laptop + ZeroTier)

Un servidor pequeño, en Python 3 sin dependencias, que hace dos cosas:

1. **Sirve la web** (la misma carpeta `prague-rent-map/`).
2. **Guarda los anuncios** como archivos JSON en el disco de la laptop, para que el móvil, el PC y cualquier dispositivo de tu red ZeroTier vean la misma lista.

La web sigue guardando una copia en cada navegador. Si el servidor no está (o se cae la conexión), todo funciona igual y se sincroniza al volver. Si abres la web desde otro sitio, por ejemplo GitHub Pages, no hay servidor: la app se queda local, como siempre.

> **Por defecto no tiene contraseña.** Los anuncios llevan teléfonos y capturas de terceros. Lo que lo protege es que **solo escucha en la IP de ZeroTier** y solo la alcanzan los dispositivos autorizados en tu red. Si lo vas a exponer a internet (ngrok, Cloudflare…), **ponle contraseña** antes: mira «Contraseña (opcional)» más abajo.

## Requisitos
Python 3.10 o superior y `git` (Ubuntu 22.04 los trae). No hace falta Node ni Docker.

## Instalar (una vez)

```sh
cd ~
git clone --depth 1 --filter=blob:none --sparse https://github.com/Gruzver/Portfolio rent-map-app
cd rent-map-app
git sparse-checkout set prague-rent-map      # solo baja esta carpeta (~15 MB), no los 199 MB del portafolio
chmod +x prague-rent-map/server/run.sh
mkdir -p ~/rent-map-data
```

## Probarlo a mano

```sh
~/rent-map-app/prague-rent-map/server/run.sh
```

Debe imprimir `serving ... on http://<IP-ZeroTier>:8789/`. Desde un dispositivo conectado a tu red ZeroTier abre esa dirección. Para parar: `Ctrl+C`.

Para comprobar que **no** escucha en todas las interfaces:

```sh
ss -ltnp | grep 8789        # debe salir la IP de ZeroTier, nunca 0.0.0.0 ni *
curl http://<IP-ZeroTier>:8789/api/ping
```

## Que arranque solo al encender (cron `@reboot`)

`crontab -e` y añade:

```
@reboot $HOME/rent-map-app/prague-rent-map/server/run.sh >> $HOME/rent-map-data/server.log 2>&1
```

`run.sh` espera hasta ~5 minutos a que ZeroTier tenga interfaz (cron arranca antes), resuelve la IP en cada arranque, y **se niega a arrancar** si no la encuentra: nunca cae a `0.0.0.0`.

Variables opcionales: `RENTMAP_PORT` (por defecto 8789), `RENTMAP_DATA` (por defecto `~/rent-map-data`), `RENTMAP_BIND` (IP fija, solo para pruebas), y las de contraseña (`RENTMAP_PASSWORD`, `RENTMAP_MIN_PASSWORD`, `RENTMAP_ENV_FILE`, `RENTMAP_REQUIRE_PASSWORD`) que se explican abajo.

## Actualizar a una versión nueva

```sh
cd ~/rent-map-app && git pull
pkill -f 'prague-rent-map/server/server.py'
nohup ./prague-rent-map/server/run.sh >> ~/rent-map-data/server.log 2>&1 &
```

(o simplemente reinicia la laptop). Los navegadores recogen la web nueva al recargar.

## Dónde están tus datos

```
~/rent-map-data/
  listings/<id>.json     un archivo por anuncio (con sus fotos)
  deleted/<id>.json      marcas de borrado, para que un borrado llegue a todos los dispositivos
  backups/AAAA-MM-DD/    copia diaria automática; guarda los últimos 14 días
  server.log             solo escrituras y errores
```

Para restaurar una copia, para el servidor, copia el contenido de `backups/<fecha>/listings` y `deleted` sobre `listings/` y `deleted/`, y vuelve a arrancarlo. Las copias diarias están en el mismo disco: si te importa de verdad, copia `~/rent-map-data` de vez en cuando a otro sitio. El botón **«Exportar copia»** de la web sigue ahí.

## Pasar lo que ya tienes al servidor

Cada dirección web es un "sitio" distinto para el navegador, así que lo guardado en la versión de GitHub Pages no se mueve solo:

1. En la versión de GitHub Pages: **Exportar copia**.
2. En la versión del servidor: **Importar copia**. Se sube al servidor.
3. Los demás dispositivos lo reciben solos al abrir la web del servidor.

## Cómo se sincroniza

- Cada anuncio se reconcilia por separado: **gana el cambio más reciente** (por la fecha de edición). Un borrado más reciente que una edición gana; una edición posterior a un borrado lo revive.
- Se sincroniza al abrir, tras cada cambio, cada 30 segundos con la pestaña visible, al volver a la pestaña y al recuperar la conexión.
- Usa la hora de cada dispositivo. Si dos dispositivos tuvieran el reloj muy desfasado y editaras el mismo anuncio en ambos casi a la vez, podría ganar el equivocado. Para una sola persona es un riesgo pequeño.
- Si importas un anuncio que habías borrado antes en ese dispositivo, se entiende como "tráelo de vuelta".

## Contraseña (opcional)

Con `RENTMAP_PASSWORD` definida, **todas** las peticiones (la web, los archivos y la API) piden usuario y contraseña con la ventana normal del navegador («autenticación básica»). Es la pantalla de contraseña más simple que hay: sirve **cualquier nombre de usuario**, lo único que se comprueba es la contraseña. El navegador la recuerda mientras dura la sesión y la web sincroniza igual que siempre.

1. Guarda la contraseña en un archivo que solo tú leas, **fuera del repositorio** (por ejemplo `~/.config/rentmap/server.env`):
   ```
   RENTMAP_PASSWORD="una frase larga que solo tú sepas"
   ```
   ```sh
   mkdir -p ~/.config/rentmap && chmod 700 ~/.config/rentmap
   nano ~/.config/rentmap/server.env && chmod 600 ~/.config/rentmap/server.env
   ```
   Es un archivo de `CLAVE=valor` que lee `bash`: si la contraseña lleva espacios, `$` o comillas, ponla entre comillas simples (`'...'`). Escríbela tú; no la pegues en chats ni en el repo.
2. Dile a `run.sh` dónde está y exige que exista. En el `crontab`:
   ```
   RENTMAP_ENV_FILE=/home/TU_USUARIO/.config/rentmap/server.env
   RENTMAP_REQUIRE_PASSWORD=1
   @reboot $HOME/rent-map-app/prague-rent-map/server/run.sh >> $HOME/rent-map-data/server.log 2>&1
   ```
   (cron no expande `$HOME` en las líneas de variables: usa la ruta completa). Para probarlo a mano: `RENTMAP_ENV_FILE=~/.config/rentmap/server.env RENTMAP_REQUIRE_PASSWORD=1 ~/rent-map-app/prague-rent-map/server/run.sh`.

Detalles que conviene saber:

- La contraseña tiene **mínimo 8 caracteres** (ver el último punto si quieres una más corta, a conciencia). Una contraseña vacía se rechaza (no se interpreta como «sin contraseña»), y con `RENTMAP_REQUIRE_PASSWORD=1` (`--require-password` en `server.py`) el servidor **se niega a arrancar** si no hay ninguna. Así un archivo mal escrito o una variable que no cargó nunca deja el servidor abierto sin que te enteres. La línea de arranque en el log dice `password: required` o `password: none`; nunca imprime la contraseña.
- Las contraseñas incorrectas se contestan **de una en una, con medio segundo entre ellas, para todo el servidor**: como mucho unos 2 intentos fallidos por segundo, abra el atacante las conexiones que abra (detrás de un túnel todas las peticiones llegan desde la misma dirección, así que no se puede limitar por IP). Quien escribe la contraseña correcta nunca espera; quien se equivoca puede esperar un poco si alguien está probando a la vez. Eso frena la fuerza bruta contra una contraseña larga, pero **no protege una corta**: con 2 caracteres bastan de unos 10 minutos a poco más de una hora.
- Va por **HTTP**: dentro de ZeroTier no importa (el tráfico ya va cifrado), y por ngrok o Cloudflare el tramo de internet va cifrado con HTTPS. Sin túnel y fuera de ZeroTier, la contraseña viajaría en claro: no lo uses así.
- Para cambiar la contraseña: edita el archivo y reinicia `run.sh`.
- **Una contraseña corta, a conciencia.** Para una herramienta temporal puedes bajar el mínimo con `RENTMAP_MIN_PASSWORD=2` en el mismo archivo (un número entero de 1 o más; vacía nunca se acepta). El servidor arranca y escribe un aviso en el log (`fewer than 8 characters`). Es tu decisión, pero tenlo claro: cualquiera que encuentre la dirección del túnel puede leer y borrar los anuncios, y los anuncios llevan teléfonos de terceros. Las copias diarias de 14 días cubren el borrado, no la lectura.
- `ngrok.sh` sigue funcionando: da el servidor por activo si responde 200 o 401.

## Exponerlo a internet con Cloudflare Tunnel «rápido» (opcional, sin cuenta)

Es la vía que se usa en la laptop de producción: no necesita cuenta ni página de aviso. `cloudflared` abre un túnel y te da una dirección `https://algo-aleatorio.trycloudflare.com` (la imprime en su salida al arrancar). **Cambia cada vez que arrancas el túnel**, así que conviene guardarla o enviártela al arrancar en vez de recordarla. **Hazlo siempre con contraseña** (sección «Contraseña»): Cloudflare no añade ningún login a estos túneles.

El servidor solo contesta a la API si el `Host` de la petición es el esperado, y el túnel envía su propio nombre. Lo más sencillo es decirle a `cloudflared` que reescriba el `Host` hacia la dirección interna (así no hay que dar de alta el nombre aleatorio):

```sh
cloudflared tunnel --url http://<IP-ZeroTier>:8789 --http-host-header <IP-ZeroTier>:8789
```

Sin ese `--http-host-header` la web carga pero la sincronización falla con «host not allowed» (403). El servidor sigue escuchando solo en la IP de ZeroTier; `cloudflared` corre en la misma laptop y se conecta desde dentro. Para cerrar el acceso, para el proceso `cloudflared`: la dirección deja de existir. Conviene abrir el túnel solo cuando el servidor ya responde (un 401 también cuenta como «responde»), y resolver la IP de ZeroTier en cada arranque como hace `run.sh`.

Como entras desde una dirección que no es privada, la web sincroniza cada 5 minutos en vez de cada 30 segundos; lo que editas se envía al momento.

## Alternativa: exponerlo con ngrok (opcional)

Solo si necesitas entrar desde un dispositivo que no tiene ZeroTier. **Sin contraseña, cualquiera que tenga la dirección puede leer, editar y borrar todos los anuncios** (con capturas y teléfonos de terceros): configura antes la contraseña (sección «Contraseña»), y puedes abrir el túnel solo cuando haga falta.

El servidor sigue escuchando **solo en la IP de ZeroTier**. El programa de ngrok corre en la misma laptop y se conecta a él desde dentro, así que no se abre ningún puerto en el router.

1. Crea una cuenta gratuita en ngrok. En su panel verás tu **dominio** gratuito (algo como `nombre.ngrok-free.app`) y tu **authtoken**.
2. Instala ngrok en la laptop siguiendo https://ngrok.com/download/linux y registra el token **a mano en tu terminal**: `ngrok config add-authtoken <TU_TOKEN>`. No lo pegues en chats ni en archivos del repo.
3. Declara tu dominio para el servidor y para el túnel, **una vez**, en la parte de arriba del `crontab` (`crontab -e`), antes de las líneas `@reboot`:
   ```
   RENTMAP_NGROK_DOMAIN=nombre.ngrok-free.app
   @reboot $HOME/rent-map-app/prague-rent-map/server/run.sh >> $HOME/rent-map-data/server.log 2>&1
   @reboot $HOME/rent-map-app/prague-rent-map/server/ngrok.sh >> $HOME/rent-map-data/ngrok.log 2>&1
   ```
   `run.sh` acepta ese nombre como `Host` válido y `ngrok.sh` abre el túnel hacia la IP de ZeroTier cuando el servidor ya responde. Para probarlo a mano sin reiniciar: `RENTMAP_NGROK_DOMAIN=nombre.ngrok-free.app ~/rent-map-app/prague-rent-map/server/ngrok.sh` (reinicia antes `run.sh` con la misma variable).
4. Abre `https://nombre.ngrok-free.app/`. La primera vez ngrok muestra una página de aviso: pulsa para continuar (se recuerda 7 días).

Cosas que conviene saber del plan gratuito (según su documentación): 1 GB de salida y 20 000 peticiones HTTP al mes. Por eso, cuando entras por internet la web sincroniza cada 5 minutos en vez de cada 30 segundos, y los cambios que haces siguen enviándose al momento. Los archivos pesados (`vendor/`, `assets/`) se guardan un día en el navegador para gastar menos peticiones. Todo el tráfico pasa por los servidores de ngrok.

Para cerrar el acceso público basta con borrar la línea de `ngrok.sh` del `crontab` y parar el proceso `ngrok`.

## Seguridad: qué hace y qué no

- Solo escucha en la IP que le das; con `0.0.0.0` se niega salvo `--allow-any-interface`.
- Solo responde a peticiones cuyo `Host` sea el esperado (la IP, `localhost`): protege contra el ataque de "DNS rebinding". Si algún día entras por un nombre DNS, añade `--allow-host nombre:8789` a la línea de `run.sh`.
- Los identificadores de anuncio se validan (`A-Z a-z 0-9 _ -`): no hay recorrido de directorios. El directorio de datos no puede estar dentro de la carpeta web.
- Límite de 40 MB por anuncio (`--max-body-mb`).
- Con `RENTMAP_PASSWORD` pide contraseña en todas las rutas (comparación en tiempo constante). Sin ella **no tiene** autenticación: cualquier miembro autorizado de tu red ZeroTier puede leer, editar y borrar.
- **No tiene** cifrado propio (HTTP; el navegador mostrará «No seguro») ni registro de quién accede, y la contraseña es una sola para todos.

## Problemas típicos

| Síntoma | Qué mirar |
| --- | --- |
| La web dice «Sin conexión con el servidor» | ¿ZeroTier conectado en ese dispositivo? ¿La laptop encendida? `curl http://<IP>:8789/api/ping` desde otra máquina de la red. Los cambios se guardan en el dispositivo y se envían al volver. |
| No arranca tras reiniciar | Mira `~/rent-map-data/server.log`. Si dice que no encontró interfaz ZeroTier, comprueba `systemctl status zerotier-one` y `ip -4 -brief addr`. |
| Cambió la IP de ZeroTier | Nada: se resuelve en cada arranque. Solo hay que usar la IP nueva en el navegador. |
| ngrok dice que el dominio no es válido o no conecta | Comprueba `ngrok http --help` (los agentes recientes usan `--url`, los antiguos `--domain`; `ngrok.sh` prueba los dos), que el token está registrado y `~/rent-map-data/ngrok.log`. |
| Por internet sale "host not allowed" (403) | El dominio de `RENTMAP_NGROK_DOMAIN` no coincide con el que usas, o reiniciaste ngrok pero no `run.sh` con la variable. |
| El navegador pide usuario y contraseña | Es la contraseña de `RENTMAP_PASSWORD`; el usuario puede ser cualquiera. Si no la recuerdas, cámbiala en el archivo y reinicia `run.sh`. |
| Al arrancar dice «password must have at least 8 characters» / «no password is configured» | `RENTMAP_ENV_FILE` apunta a un archivo sin `RENTMAP_PASSWORD`, o la contraseña está vacía o es más corta que el mínimo. Revisa el archivo (y que cron lo vea: ruta completa). Si quieres una corta a propósito, añade `RENTMAP_MIN_PASSWORD=<largo>`. |
| Por Cloudflare la web carga pero no sincroniza (403) | Falta `--http-host-header <IP-ZeroTier>:8789` en el comando de `cloudflared`. |
| El puerto está ocupado | Cambia `RENTMAP_PORT` (8787 y 8788 los usan otros servicios tuyos). |

## Pruebas

```sh
python3 -m unittest discover -s server -v
bash server/test_launchers.sh
```
