# DeliriumAI (Mineflayer + OpenAI) - Render Ready

## Requisitos
- Node 18+
- Un usuario Java para el bot
- OpenAI API Key

## Variables de entorno (Render -> Environment)
OPENAI_API_KEY=...
MC_HOST=tu-dominio-o-ip
MC_PORT=25565
MC_USER=DeliriumAI_1
MC_VERSION=1.21.1
# opcional:
MC_LOGIN_CMD=/login tuPassword
# logs
LOG_DIR=./logs

## Run local
npm i
node index.js

## Render
Crear Web Service y setear env vars.
El servicio abre HTTP en 0.0.0.0:$PORT (Render default 10000).