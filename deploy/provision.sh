#!/usr/bin/env bash
#
# Provision the Milestone 5.1 host baseline for the IdentiK live Instance.
# Idempotent: safe to re-run at any point.
#
#   su - root
#   bash <(curl -fsSL https://raw.githubusercontent.com/Mohaned178/IdentiK/v0.1.0/deploy/provision.sh)
#
# or:
#   curl -fsSLO https://raw.githubusercontent.com/Mohaned178/IdentiK/v0.1.0/deploy/provision.sh
#   bash provision.sh
#
# Applies: key-only SSH, UFW 22/80/443, unattended security updates (no
# automatic reboots), Docker + compose v2 from the official repository, and
# the deploy directory layout. The runbook is deploy/README.md §14.
set -euo pipefail

WANTED_DISTRO="Ubuntu"
DOCKER_REPO="https://download.docker.com/linux/ubuntu"

echo "==> provisioning the IdentiK host baseline"

[ "$(id -u)" -eq 0 ] || { echo "run as root: su - root" >&2; exit 1; }

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "    distro: ${PRETTY_NAME:-unknown}"
  if [ "${ID:-}" != "ubuntu" ] && [ "${ID_LIKE:-ubuntu}" != "ubuntu" ]; then
    echo "WARNING: this script targets Ubuntu (Docker's official repository is" >&2
    echo "         keyed to it). Continuing anyway may fail; review before signing off." >&2
  fi
else
  echo "WARNING: /etc/os-release missing; assuming a Debian-family system." >&2
  ID_LIKE=ubuntu
fi

# ---------------------------------------------------------------------------
# 1. Key-only SSH
# ---------------------------------------------------------------------------
echo "==> hardening SSH (key-only)"
AUTHKEYS="/root/.ssh/authorized_keys"
if [ -s "$AUTHKEYS" ]; then
  cat >/etc/ssh/sshd_config.d/99-identik.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  chmod 0644 /etc/ssh/sshd_config.d/99-identik.conf
  if ! sshd -t; then
    echo "ERROR: sshd config test failed; not reloading SSH." >&2
    exit 1
  fi
  systemctl reload ssh || systemctl reload sshd
  echo "    SSH locked to key-only auth."
else
  echo "WARNING: /root/.ssh/authorized_keys is empty; leaving SSH as-is so you" >&2
  echo "         are not locked out. Attach a key, then re-run this script." >&2
fi

# ---------------------------------------------------------------------------
# 2. Firewall: 22/80/443 only
# ---------------------------------------------------------------------------
echo "==> configuring the firewall (22/80/443 only)"
export DEBIAN_FRONTEND=noninteractive
if ! command -v ufw >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ufw
fi
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose | head -n 12

# ---------------------------------------------------------------------------
# 3. Base tooling
# ---------------------------------------------------------------------------
echo "==> installing base tooling (curl git openssl age rsync)"
apt-get update -qq
apt-get install -y -qq curl git openssl age rsync

# ---------------------------------------------------------------------------
# 4. Unattended security updates (no automatic reboots)
# ---------------------------------------------------------------------------
echo "==> enabling unattended security updates"
apt-get install -y -qq unattended-upgrades
cat >/etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
  "${distro_id}:${distro_codename}-updates";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 5. Docker + compose v2 from the official repository
# ---------------------------------------------------------------------------
echo "==> installing Docker from the official ${DOCKER_REPO}"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "${DOCKER_REPO}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] ${DOCKER_REPO} ${VERSION_CODENAME:-noble} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker --version
docker compose version

# ---------------------------------------------------------------------------
# 6. Deploy directory layout
# ---------------------------------------------------------------------------
echo "==> creating /opt/identik"
install -d -o root -g root -m 0755 /opt/identik

echo
echo "==> host baseline complete"
echo "    Next: clone the release and run the first deploy."
echo "      cd /opt/identik && git clone https://github.com/Mohaned178/IdentiK.git . "
echo "      git checkout v0.1.0"
echo "      bash deploy/setup-env.sh   # fill in IDENTIK_HOSTNAME / SMTP, generates keys"
echo "      bash deploy/first-deploy.sh"