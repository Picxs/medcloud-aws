#!/bin/bash
# Envia o código local para a EC2 e reinicia os serviços. Uso: ./infra/deploy.sh <IP>
set -e
cd "$(dirname "$0")/.."
H="ec2-user@${1:?informe o IP}"; K="-i .aws/labsuser.pem -o StrictHostKeyChecking=no"
tar czf - package.json package-lock.json src public .env | ssh $K $H \
  'sudo tar xzf - -C /opt/medcloud && cd /opt/medcloud && sudo npm install --omit=dev --no-audit --no-fund >/dev/null && sudo systemctl restart medcloud-web medcloud-worker && echo deploy ok'
