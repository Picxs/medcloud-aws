#!/bin/bash
# User Data da EC2 (Amazon Linux 2023). Usado na instância da Parte 1 e no Launch Template da Parte 2.
# Antes de usar: substitua REPO_URL e cole o conteúdo do seu .env entre os marcadores ENV.
set -eux
dnf install -y nodejs20 git
alternatives --set node /usr/bin/node-20 2>/dev/null || ln -sf /usr/bin/node-20 /usr/bin/node
ln -sf /usr/bin/npm-20 /usr/bin/npm 2>/dev/null || true

git clone REPO_URL /opt/medcloud
cd /opt/medcloud
cat > .env <<'ENV'
# >>> cole aqui o conteúdo do .env gerado por `npm run infra:status` <<<
ENV
npm install --omit=dev

for svc in web worker; do
  cmd=$([ "$svc" = web ] && echo "src/server.js" || echo "src/worker.js")
  cat > /etc/systemd/system/medcloud-$svc.service <<UNIT
[Unit]
Description=MedCloud $svc
After=network-online.target
[Service]
WorkingDirectory=/opt/medcloud
ExecStart=/usr/bin/node $cmd
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable --now medcloud-web medcloud-worker
